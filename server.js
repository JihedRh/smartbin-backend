const express = require("express");
const cors = require("cors");
const mysql = require("mysql");
const fs = require('fs');
const path = require('path');
const multer = require('multer');
require('dotenv').config();


const app = express();
app.use(express.json());
app.use(cors());

// Serve static files from "uploads"
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer setup
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // Save to 'uploads/' folder
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + path.extname(file.originalname); // e.g., 1746383211526.jpg
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

const db = mysql.createConnection({
  host: process.env.HOST,
  user: process.env.USER,
  password: process.env.PASSWORD,
  database : process.env.DATABASE,
});


const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
app.post('/api/updateUserPoints', (req, res) => {
  const { user_code, giftpoints } = req.body;

  // SQL query to get user data by id
  const query = 'SELECT id, email, password, full_name, created_at, updated_at, giftpoints, nb_trashthrown, smart_bin_id, role, isbanned FROM users WHERE user_code = ?';

  db.query(query, [user_code], (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send({ message: 'Server error' });
    }

    if (results.length > 0) {
      const user = results[0];

      // Check if the user is banned
      if (user.isbanned) {
        return res.status(403).send({ message: 'Your account has been banned or disabled. Please contact support.' });
      }

      // Calculate the new values for nb_trashthrown and giftpoints
      const newNbTrashThrown = user.nb_trashthrown + 1;
      const newGiftPoints = user.giftpoints + giftpoints;

      // Update the user's nb_trashthrown and giftpoints in the database
      const updateQuery = `
        UPDATE users 
        SET nb_trashthrown = ?, giftpoints = ?, updated_at = NOW() 
        WHERE user_code = ?
      `;

      db.query(updateQuery, [newNbTrashThrown, newGiftPoints, user_code], (updateErr) => {
        if (updateErr) {
          console.error('Error updating user:', updateErr);
          return res.status(500).send({ message: 'Error updating user data' });
        }

        // Return the updated full_name and total giftpoints
        res.status(200).send({
          message: 'User updated successfully!',
          full_name: user.full_name,
          total_giftpoints: newGiftPoints,
        });
      });
    } else {
      res.status(404).send({ message: 'User not found' });
    }
  });
});
app.get('/api/binvision/reference/:bin_reference', (req, res) => {
  const binReference = req.params.bin_reference;

  // First, find the hospital_id for that bin reference
  const getHospitalQuery = `SELECT hospital_id FROM smart_trash_bin WHERE reference = ? LIMIT 1`;

  db.query(getHospitalQuery, [binReference], (err, hospitalResult) => {
    if (err) {
      console.error("Error fetching hospital id:", err);
      return res.status(500).json({ error: "Database error" });
    }

    if (hospitalResult.length === 0) {
      return res.status(404).json({ error: "Bin reference not found" });
    }

    const hospitalId = hospitalResult[0].hospital_id;

    // Now fetch all bins for that hospital_id
    const query = `
      SELECT b.reference, b.location, bv.fill_level
      FROM smart_trash_bin b
      LEFT JOIN (
        SELECT reference, fill_level
        FROM bin_values bv1
        WHERE timestamp = (
          SELECT MAX(timestamp)
          FROM bin_values bv2
          WHERE bv1.reference = bv2.reference
        )
      ) AS bv ON b.reference = bv.reference
      WHERE b.hospital_id = ?
    `;

    db.query(query, [hospitalId], (err, result) => {
      if (err) {
        console.error("Error fetching bins:", err);
        return res.status(500).json({ error: "Database error" });
      }
      res.json(result);
    });
  });
});

app.post("/insert", (req, res) => {
  const dataArray = Array.isArray(req.body) ? req.body : [req.body];

  const insertSql = `
    INSERT INTO bin_values 
    (co2_level, temperature, humidity, fill_level, reference) 
    VALUES ?
  `;
  const insertValues = dataArray.map(({ co2_level, temperature, humidity, fill_level, reference }) => [
    co2_level, temperature, humidity, fill_level, reference
  ]);

  const statuses = dataArray.map(({ fill_level, reference }) => {
    let statut = 'empty';
    if (fill_level >= 50 && fill_level <= 80) statut = 'almost full';
    else if (fill_level > 80) statut = 'full';
    return [statut, reference];
  });

  // Insert values into bin_values
  db.query(insertSql, [insertValues], (err) => {
    if (err) {
      console.error("Insert error:", err);
      return res.status(500).send("Insert DB error");
    }

    // Update statuses in bulk
    const updateSql = `
      UPDATE smart_trash_bin 
      SET statut = CASE reference
        ${statuses.map(({ statut, reference }) => `WHEN '${reference}' THEN '${statut}'`).join(' ')}
      END
    `;
    db.query(updateSql, (err) => {
      if (err) {
        console.error("Update error:", err);
        return res.status(500).send("Update DB error");
      }
      res.send("Batch insert and bin statuses updated");
    });
  });
});


app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  
  const query = 'SELECT full_name, email, role, isbanned,user_code, password FROM users WHERE email = ?';

  db.query(query, [email], (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send({ message: 'Server error' });
    }

    if (results.length > 0) {
      const { full_name, email, role,user_code ,  isbanned, password: storedPassword } = results[0];

      if (isbanned) {
        return res.status(403).send({ message: 'Your account has been banned or disabled . Please contact support.' });
      }

      // Compare the provided password with the hashed password in the database
      bcrypt.compare(password, storedPassword, (err, isMatch) => {
        if (err) {
          return res.status(500).send({ message: 'Error comparing password' });
        }

        if (!isMatch) {
          return res.status(401).send({ message: 'Invalid email or password' });
        }

        const payload = {
          full_name,
          email,
          role,
        };

        const secretKey = '7874fyyvgvgvyvyvg454444ygygkinzzllfdllfdkkfkd';
        const token = jwt.sign(payload, secretKey, { expiresIn: '24h' });

        res.status(200).send({ 
          message: 'Login successful!',
          token,
          full_name, 
          email,
          role , 
          user_code
        });
      });
    } else {
      res.status(401).send({ message: 'Invalid email or password' });
    }
  });
});


  
  app.get('/api/users', (req, res) => {
    const query = 'SELECT * FROM users';
    db.query(query, (err, results) => {
      if (err) {
        console.error('Error fetching users:', err);
        res.status(500).send('Server error');
      } else {
        res.json(results);
      }
    });
  });


app.get('/api/users/:email', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT * FROM users WHERE email = ?';

  db.query(query, [email], (err, results) => {
    if (err) {
      console.error('Error fetching user by email:', err);
      res.status(500).send('Server error');
    } else if (results.length === 0) {
      res.status(404).send('User not found');
    } else {
      res.json(results[0]); // Send the first matched user
    }
  });
});


app.get('/api/user/username/:email', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT full_name FROM users WHERE email = ?';

  db.query(query, [email], (err, results) => {
    if (err) {
      console.error('Error fetching username by email:', err);
      res.status(500).send('Server error');
    } else if (results.length === 0) {
      res.status(404).send('Data not found');
    } else {
      res.json(results[0]); // Send { username: "..." }
    }
  });
});

app.get('/api/users/giftpoints/:email', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT giftpoints FROM users WHERE email = ?';

  db.query(query, [email], (err, results) => {
    if (err) {
      console.error('Error fetching giftpoints by email:', err);
      res.status(500).send('Server error');
    } else if (results.length === 0) {
      res.status(404).send('Data not found');
    } else {
      res.json(results[0]); // Send the first matched user
    }
  });
});

app.get('/api/users/points-goal/:email', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT points_goal FROM users WHERE email = ?';

  db.query(query, [email], (err, results) => {
    if (err) {
      console.error('Error fetching points goal by email:', err);
      res.status(500).send('Server error');
    } else if (results.length === 0) {
      res.status(404).send('Data not found');
    } else {
      res.json(results[0]); // Send the first matched user
    }
  });
});

app.put('/api/user/points-goal', (req, res) => {
  const { email, points_goal } = req.body;

  if (!email || points_goal === undefined) {
    return res.status(400).json({ error: 'Email and points_goal are required' });
  }

  const query = 'UPDATE users SET points_goal = ? WHERE email = ?';

  db.query(query, [points_goal, email], (err, result) => {
    if (err) {
      console.error('Error updating points_goal:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Points goal updated successfully' });
  });
});

app.post('/upload-profile-image', upload.single('image'), (req, res) => {
  const email = req.body.email;
  const file = req.file;

  if (!email || !file) {
    return res.status(400).json({ message: 'Email or image not provided.' });
  }

  const relativeImagePath = `/uploads/${file.filename}`;

  const query = 'UPDATE users SET profile_image = ? WHERE email = ?';
  db.query(query, [relativeImagePath, email], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ message: 'Database error.' });
    }

    return res.status(200).json({
      message: 'Profile image uploaded successfully.',
      profile_image: relativeImagePath, // only relative path is returned
    });
  });
});
  


  app.get('/api/user-count', (req, res) => {
    const query = 'SELECT COUNT(*) AS count FROM users';  
    db.query(query, (err, result) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ count: result[0].count });
      }
    });
  });

app.get('/api/user/:email', (req, res) => {
  const { email } = req.params;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter is required' });
  }

  const query = `SELECT role FROM users WHERE email = ?`;

  db.query(query, [email], (err, results) => {
    if (err) {
      console.error('Error fetching bin data:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Route to get bins with reference and fill_level in mobile with list
app.get('/bins-list/fill-level', (req, res) => {
  const { refs } = req.query;

  if (!refs) {
    return res.status(400).json({ error: 'Missing refs query parameter' });
  }

  // Split the refs into an array
  const refList = refs.split(',');

  // Build the WHERE clause dynamically
  const conditions = refList.map(() => `reference LIKE ?`).join(' OR ');
  const values = refList.map(ref => `${ref}-%`);

  const query = `
    SELECT reference, fill_level 
    FROM bin_values
    WHERE ${conditions}
    ORDER BY timestamp DESC;
  `;

  db.query(query, values, (err, results) => {
    if (err) {
      console.error('Query error:', err);
      return res.status(500).json({ error: 'Database query failed' });
    }

    res.json(results);
  });
});

// Route to get bins with reference and fill_level
app.get('/bins/fill-level', (req, res) => {
  const query = `
    SELECT reference, fill_level 
    FROM bin_values
    ORDER BY timestamp DESC;
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Query error:', err);
      return res.status(500).json({ error: 'Database query failed' });
    }

    res.json(results);
  });
});

  app.get('/api/bin-count', (req, res) => {
    const query = 'SELECT COUNT(*) AS count FROM smart_trash_bin';  
    db.query(query, (err, result) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ count: result[0].count });
      }
    });
  });
  

  app.get('/api/smart-bins/ok', (req, res) => {
    const query = `SELECT COUNT(*) AS count FROM smart_trash_bin WHERE functionality = 'ok'`;
  
    db.query(query, (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Database error');
      }
      res.status(200).json({ count: results[0].count });
    });
  });

app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { email, full_name } = req.body;

  if (!email || !full_name) {
    return res.status(400).json({ message: 'Email and full name are required' });
  }

  const query = `
    UPDATE users
    SET email = ?, full_name = ?, updated_at = NOW()
    WHERE id = ?
  `;

  const values = [email, full_name, id];

  db.query(query, values, (err, result) => {
    if (err) {
      console.error('Error updating user:', err);
      return res.status(500).json({ message: 'Server error' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Insert into notifications after successful update
    const notificationQuery = `
      INSERT INTO notifications (type, title, description, is_unread, posted_at , forrr) 
      VALUES (?, ?, ?, ?, NOW() , ?)
    `;

    const notificationData = [
      'update', 
      `${full_name} - User Updated`, // Title now includes user's name
      `${full_name} 's profile has been updated  `, 
      1 , full_name
    ];

    db.query(notificationQuery, notificationData, (err) => {
      if (err) {
        console.error('Error inserting notification:', err);
        return res.status(500).json({ message: 'User updated, but failed to add notification' });
      }

      res.status(200).json({ message: 'User updated successfully and notification added' });
    });
  });
});



  app.delete('/api/users/:id', (req, res) => {
    const userId = req.params.id;
    const query = 'DELETE FROM users WHERE id = ?';
    db.query(query, [userId], (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Error deleting user');
      }
      res.status(200).send('User deleted successfully');
    });
  });
  
  app.delete('/api/users', (req, res) => {
    const { ids } = req.body;
  
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No user IDs provided' });
    }
  
    const placeholders = ids.map(() => '?').join(',');
    const query = `DELETE FROM users WHERE id IN (${placeholders})`;
  
    db.query(query, ids, (err, result) => {
      if (err) {
        console.error('Error deleting users:', err);
        return res.status(500).json({ message: 'Error deleting users from database' });
      }
  
      // Insert notification after deletion
      const notificationQuery = `
        INSERT INTO notifications (type, title, description, is_unread, posted_at, forrr) 
        VALUES (?, ?, ?, ?, NOW(), ?)`;
  
      const notificationData = [
        'system',
        `Users deleted`,
        `${result.affectedRows} users have been deleted.`,
        1,
        'admin'
      ];
  
      db.query(notificationQuery, notificationData, (err) => {
        if (err) {
          console.error("Error inserting notification:", err);
          return res.status(500).json({ message: "Error inserting notification into database" });
        }
  
        res.status(200).json({ message: `${result.affectedRows} users deleted successfully` });
      });
    });
  });
  

  app.get('/api/smart-bins/no-ok', (req, res) => {
    const query = `SELECT COUNT(*) AS count FROM smart_trash_bin WHERE functionality = 'no ok'`;
  
    db.query(query, (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Database error');
      }
      res.status(200).json({ count: results[0].count });
    });
  });
  
  app.get('/api/bins/temperature/:binReference', (req, res) => {
    const { binReference } = req.params;
    const query = `
    SELECT temperature 
    FROM bin_values 
    WHERE reference = ? 
    ORDER BY id DESC 
    LIMIT 1;
  `;
    db.query(query, [binReference], (err, results) => {
      if (err) {
        console.error('Error fetching temperature:', err);
        return res.status(500).json({ error: 'Failed to fetch temperature' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Bin not found' });
      }
      res.json(results[0]); 
    });
  });
  
  app.get('/api/bins/humidity/:binReference', (req, res) => {
    const { binReference } = req.params;
    const query = `
    SELECT humidity 
    FROM bin_values 
    WHERE reference = ? 
    ORDER BY id DESC 
    LIMIT 1;
  `; 
    db.query(query, [binReference], (err, results) => {
      if (err) {
        console.error('Error fetching humidity:', err);
        return res.status(500).json({ error: 'Failed to fetch humidity' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Bin not found' });
      }
      res.json(results[0]); 
    });
  });

  app.get('/api/bins/fill/:binReference', (req, res) => {
    const { binReference } = req.params;
    const query = `
    SELECT fill_level 
    FROM bin_values 
    WHERE reference = ? 
    ORDER BY id DESC 
    LIMIT 1;
  `;
    db.query(query, [binReference], (err, results) => {
      if (err) {
        console.error('Error fetching fill_level:', err);
        return res.status(500).json({ error: 'Failed to fetch fill_level' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Bin not found' });
      }
      res.json(results[0]); 
    });
  });

  app.get('/api/bins/co2/:binReference', (req, res) => {
    const { binReference } = req.params;
    const query = `
    SELECT co2_level 
    FROM bin_values 
    WHERE reference = ? 
    ORDER BY id DESC 
    LIMIT 1;
  `;
    db.query(query, [binReference], (err, results) => {
      if (err) {
        console.error('Error fetching co2_level:', err);
        return res.status(500).json({ error: 'Failed to fetch co2_level' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Bin not found' });
      }
      res.json(results[0]); 
    });
  });
 //********************************************************************* */
 app.delete('/api/trashbins', (req, res) => {
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No IDs provided or invalid format' });
  }

  const disableFKQuery = 'SET foreign_key_checks = 0;';
  db.query(disableFKQuery, (error) => {
    if (error) {
      console.error('Error disabling foreign key checks:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    const queryDeleteTrashBins = `
      DELETE FROM smart_trash_bin WHERE id IN (?);
    `;

    db.query(queryDeleteTrashBins, [ids], (error, deleteResults) => {
      if (error) {
        console.error('Error deleting trash bins from smart_trash_bin:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      console.log(`Deleted ${deleteResults.affectedRows} trash bins successfully`);

      const enableFKQuery = 'SET foreign_key_checks = 1;';
      db.query(enableFKQuery, (error) => {
        if (error) {
          console.error('Error re-enabling foreign key checks:', error);
          return res.status(500).json({ error: 'Internal Server Error' });
        }

        res.status(200).json({ message: `${deleteResults.affectedRows} trash bins deleted successfully` });
      });
    });
  });
});

app.delete('/api/trashbin/:id', (req, res) => {
  const { id } = req.params;

  // Disable foreign key checks
  const disableForeignKeyChecksQuery = 'SET FOREIGN_KEY_CHECKS = 0';

  // Enable foreign key checks after deletion
  const enableForeignKeyChecksQuery = 'SET FOREIGN_KEY_CHECKS = 1';

  // Delete the trash bin completely from the database
  const deleteQuery = `
    DELETE FROM smart_trash_bin 
    WHERE id = ?`;

  db.query(disableForeignKeyChecksQuery, (error) => {
    if (error) {
      console.error('Error disabling foreign key checks:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    db.query(deleteQuery, [id], (error, results) => {
      if (error) {
        console.error('Error deleting trash bin:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      if (results.affectedRows === 0) {
        return res.status(404).json({ error: 'Trash bin not found' });
      }

      const notificationQuery = `
        INSERT INTO notifications (type, title, description, is_unread, posted_at, forrr) 
        VALUES (?, ?, ?, ?, NOW(), ?)`;

      const notificationData = [
        'system',
        `Trash bin deleted`,
        `Trash bin with ID ${id} has been permanently deleted.`,
        1,
        'manager'
      ];

      db.query(notificationQuery, notificationData, (err) => {
        if (err) {
          console.error("Error inserting notification:", err);
          return res.status(500).json({ message: "Error inserting notification into database" });
        }

        db.query(enableForeignKeyChecksQuery, (error) => {
          if (error) {
            console.error('Error enabling foreign key checks:', error);
            return res.status(500).json({ error: 'Internal Server Error' });
          }

          res.status(200).json({ message: 'Trash bin permanently deleted' });
        });
      });
    });
  });
});


app.get('/api/bin-references', (req, res) => {
  const query = 'SELECT reference FROM smart_trash_bin';
  
  db.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching bin references:', error);
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.json(results.map(row => row.reference));
    }
  });
});

app.get('/api/bin-references-hop', (req, res) => {
  const query = 'SELECT id, reference FROM smart_trash_bin';
  
  db.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching bin references:', error);
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.json(results); 
    }
  });
});


app.get('/api/bin-references-type', (req, res) => {
  const query = "SELECT reference FROM smart_trash_bin WHERE type = '1'"; 
  
  db.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching bin references:', error);
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.json(results.map(row => row.reference));
    }
  });
});


app.get('/api/smart-trash-bins', (req, res) => {
  const query = `
    SELECT 
      bin.id, 
      bin.type,
      bin.statut, 
      bin.reference, 
      bin.functionality, 
      bin_values.co2_level, 
      bin_values.temperature, 
      bin_values.humidity, 
      bin_values.fill_level, 
      bin_values.timestamp
    FROM smart_trash_bin bin
    LEFT JOIN bin_values bin_values 
      ON bin.reference = bin_values.reference 
      AND bin_values.id = (
        SELECT MAX(id) 
        FROM bin_values 
        WHERE reference = bin.reference
      )
  `;
  
  db.query(query, (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(results);
    }
  });
});


app.post('/api/smart-trash-bins', (req, res) => {
  console.log('Request body:', req.body);

  const { reference, statut, functionality, type, location, hospital_id } = req.body;

  const typeInt = parseInt(type, 10);

  if (typeInt === 1) {
    const querySmartTrashBin = `
      INSERT INTO smart_trash_bin (reference, statut, functionality, type, location, hospital_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(querySmartTrashBin, [reference, statut, functionality, typeInt, '0 , 0', '1'], (error, results) => {
      if (error) {
        console.error('Error adding trash bin (smart_trash_bin):', error);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      const queryOrBinValues = `
        INSERT INTO or_bin_values (reference, toxic_waste, non_toxic_waste, organic_waste, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `;

      db.query(queryOrBinValues, [reference, 0, 0, 0, new Date()], (error) => {
        if (error) {
          console.error('Error adding or_bin_values:', error);
          return res.status(500).json({ error: 'Internal Server Error' });
        }

        console.log('Trash bin and OR bin values added successfully');
        res.status(201).json({ message: 'Trash bin and OR bin values added successfully' });
      });
    });

  } else if (typeInt === 2) {
    const querySmartTrashBin = `
      INSERT INTO smart_trash_bin (reference, statut, functionality, type, location, hospital_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(querySmartTrashBin, [reference, statut, functionality, typeInt, '0 , 0', '1'], (error, results) => {
      if (error) {
        console.error('Error adding trash bin (smart_trash_bin):', error);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      const queryBinValues = `
        INSERT INTO bin_values (reference, fill_level, co2_level, temperature, humidity)
        VALUES (?, ?, ?, ?, ?)
      `;

      db.query(queryBinValues, [reference, 0, 0, 0, 0], (error) => {
        if (error) {
          console.error('Error adding bin values (bin_values):', error);
          return res.status(500).json({ error: 'Internal Server Error' });
        }

        console.log('Trash bin and bin values added successfully');
        res.status(201).json({ message: 'Trash bin and bin values added successfully' });
      });
    });

  } else {
    return res.status(400).json({ error: 'Invalid type' }); 
  }
});



app.post('/api/users', (req, res) => {
  const { email, password, full_name, giftpoints, nb_trashthrown, smart_bin_id, created_at, updated_at, role } = req.body;

  if (!email || !password || !full_name) {
    return res.status(400).json({ message: 'Email, password, and full name are required' });
  }

  // Helper to generate a 13 character alphanumeric code
  const generateUserCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < 13; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };
  
  const user_code = generateUserCode();

  // Hash the password
  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) {
      console.error('Error hashing password:', err);
      return res.status(500).json({ message: 'Error hashing password' });
    }

    const query = `
      INSERT INTO users (
        email, password, full_name, giftpoints, nb_trashthrown, smart_bin_id, created_at, updated_at, role, user_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      email,
      hashedPassword,
      full_name,
      giftpoints || 0,
      nb_trashthrown || 0,
      smart_bin_id || 0,
      created_at,
      updated_at,
      role || 'user',
      user_code
    ];

    db.query(query, values, (err, result) => {
      if (err) {
        console.error('Error inserting user:', err);
        return res.status(500).json({ message: 'Server error' });
      }
      res.status(201).json({ message: 'User added successfully', userId: result.insertId, user_code });
    });
  });
});



app.get('/api/bin-values/:reference', (req, res) => {
  const { reference } = req.params;

  if (!reference) {
    return res.status(400).json({ error: 'Reference parameter is required' });
  }

  const query = `SELECT temperature, humidity, co2_level, fill_level, timestamp 
                 FROM bin_values 
                 WHERE reference = ? 
                 ORDER BY timestamp ASC LIMIT 10`;

  db.query(query, [reference], (err, results) => {
    if (err) {
      console.error('Error fetching bin data:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

app.get("/bins", (req, res) => {
  const sql = `
    SELECT s.reference, s.location, o.toxic_waste, o.non_toxic_waste, o.organic_waste
    FROM smart_trash_bin s
    JOIN or_bin_values o ON s.reference = o.reference
    WHERE s.type = '1' ORDER BY o.id DESC 

  `;
  db.query(sql, (err, result) => {
    if (err) return res.status(500).json(err);
    res.json(result);
  });
});

app.get("/bin/:reference", (req, res) => {
  const reference = req.params.reference;
  const sql = `
    SELECT s.reference, s.location, o.toxic_waste, o.non_toxic_waste, o.organic_waste
    FROM smart_trash_bin s
    JOIN or_bin_values o ON s.reference = o.reference
    WHERE s.reference = ? 
  `;
  db.query(sql, [reference], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json(result[0]);
  });
});


app.get("/bins/waste-data/:reference", (req, res) => {
  const { reference } = req.params;
  
  const query = `
    SELECT timestamp, toxic_waste, non_toxic_waste, organic_waste 
    FROM or_bin_values 
    WHERE reference = ? 
    ORDER BY timestamp DESC;
  `;

  db.query(query, [reference], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err);
      return res.status(500).json({ error: "Error fetching data" });
    }
    res.json(results);
  });
});

app.get('/api/bin-functionality', (req, res) => {
  const query = `
    SELECT functionality, COUNT(*) as count
    FROM smart_trash_bin
    WHERE functionality IN ('ok', 'no ok')
    GROUP BY functionality
  `;
  db.query(query, (err, results) => {
    if (err) {
      res.status(500).send({ error: 'Database query error' });
    } else {
      res.json(results);
    }
  });
});

app.get("/api/hospitals", (req, res) => {
  const query = "SELECT * FROM hospitals";
  db.query(query, (err, result) => {
    if (err) {
      res.status(500).json({ error: "Failed to fetch hospitals" });
      return;
    }
    res.json(result);
  });
});


app.get("/api/bins/count", (req, res) => {
  const hospitalId = req.query.hospital_id;

  if (!hospitalId) {
    return res.status(400).json({ error: "hospital_id is required" });
  }

  const query = "SELECT COUNT(*) AS binCount FROM smart_trash_bin WHERE hospital_id = ?";
  db.query(query, [hospitalId], (err, result) => {
    if (err) {
      console.error("Error fetching bin count:", err);
      return res.status(500).json({ error: "Failed to fetch bin count" });
    }
    
    const binCount = result[0].binCount;
    res.json({ hospital_id: hospitalId, bin_count: binCount });
  });
});

app.get("/api/hospitals/locations", (req, res) => {
  const query = "SELECT id, name, location FROM hospitals"; 
  db.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch hospitals' locations" });
    }
    
    const hospitals = results.map(hospital => {
      if (!hospital.location) return null; // Skip if location is missing
      const [lat, lng] = hospital.location.split(',').map(Number);
      return { id: hospital.id, name: hospital.name, lat, lng }; // Remove 'location'
    }).filter(Boolean); // Remove null entries

    res.json(hospitals);
  });
});

app.get("/api/bins/locations", (req, res) => {
  const query = "SELECT id, location FROM smart_trash_bin"; 
  db.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch smart trash bins' locations" });
    }

    const bins = results.map(bin => {
      if (!bin.location) return null; // Skip if location is missing
      const [lat, lng] = bin.location.split(',').map(Number);
      return { id: bin.id, lat, lng }; // Remove 'location'
    }).filter(Boolean); // Remove null entries

    res.json(bins);
  });
});


app.post("/api/hospitals", (req, res) => {
  const { name, address, lat, lng } = req.body;

  if (!name || !address || !lat || !lng) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const location = `POINT(${lat} ${lng})`;

  const query = `INSERT INTO hospitals (name, address, lat, lng) VALUES (?, ?, ?, ?)`;

  db.query(query, [name, address, lat, lng], (err, result) => {
    if (err) {
      console.error("Error inserting hospital data: ", err);
      return res.status(500).json({ error: "Failed to add hospital" });
    }

    const notificationQuery = `
      INSERT INTO notifications (type, title, description, is_unread, posted_at, forrr) 
      VALUES (?, ?, ?, ?, NOW(), ?)`;

    const notificationData = [
      'system',
      `New hospital added`,
      `A new hospital with the name ${name} has been added.`,
      1,
      'manager',
    ];

    db.query(notificationQuery, notificationData, (err) => {
      if (err) {
        console.error("Error inserting notification:", err);
        return res.status(500).json({ message: "Error inserting notification into database" });
      }

      res.status(201).json({
        message: "Hospital added successfully",
        hospitalId: result.insertId,
      });
    });
  });
});


app.get('/api/hospitals/:hospitalId', (req, res) => {
  const { hospitalId } = req.params;

  const hospitalQuery = `
    SELECT * FROM hospitals WHERE id = ?;
  `;
  
  db.query(hospitalQuery, [hospitalId], (err, hospitalResults) => {
    if (err) {
      console.error('Error fetching hospital data:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (hospitalResults.length === 0) {
      return res.status(404).json({ message: 'Hospital not found' });
    }

    const hospital = hospitalResults[0];
    
    const trashBinQuery = `
      SELECT type, COUNT(*) as count FROM smart_trash_bin
      WHERE hospital_id = ?
      GROUP BY type;
    `;
    
    db.query(trashBinQuery, [hospitalId], (err, trashBinResults) => {
      if (err) {
        console.error('Error fetching smart trash bins:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        hospital: {
          ...hospital,
          lat: hospital.lat,
          lng: hospital.lng
        },
        bins: trashBinResults,
      });
    });
  });
});

app.get('/api/binss/:hospitalId', (req, res) => {
  const { hospitalId } = req.params;
  console.log('Received hospitalId:', hospitalId);  
  const binQuery = `
    SELECT id, reference, functionality, type , statut 
    FROM smart_trash_bin WHERE hospital_id = ?;
  `;
  db.query(binQuery, [hospitalId], (err, results) => {
    if (err) {
      console.error('Error fetching bin data:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ bins: results });
  });
});
//nnnnnnnnnnnnnnnnnnneeeeeeeds review 

app.post('/api/hospitals/:hospitalId/add-bin', (req, res) => {
  const { hospitalId } = req.params;
  const { binReference } = req.body;

  if (!binReference) {
    return res.status(400).json({ message: 'Bin reference is required' });
  }

  const getBinQuery = `SELECT id FROM smart_trash_bin WHERE reference = ?`;

  db.query(getBinQuery, [binReference], (err, result) => {
    if (err) {
      console.error("Error fetching bin:", err);
      return res.status(500).json({ message: 'Error fetching bin' });
    }

    if (result.length === 0) {
      return res.status(404).json({ message: 'Bin not found' });
    }

    const binId = result[0].id;

    const query = `UPDATE smart_trash_bin SET hospital_id = ? WHERE id = ?`;

    db.query(query, [hospitalId, binId], (err, result) => {
      if (err) {
        console.error("Error adding bin:", err);
        return res.status(500).json({ message: 'Error adding bin' });
      }

      const notificationQuery = `
        INSERT INTO notifications (type, title, description, is_unread, posted_at, forrr) 
        VALUES (?, ?, ?, ?, NOW(), ?)`;

      const notificationData = [
        'system', 
        `Bin added to hospital`, 
        `Bin with reference ${binReference} has been added to hospital ID ${hospitalId}.`, 
        1, 'manager'
      ];

      db.query(notificationQuery, notificationData, (err) => {
        if (err) {
          console.error("Error inserting notification:", err);
          return res.status(500).json({ message: "Error inserting notification into database" });
        }
        res.status(200).json({ message: 'Bin added to hospital successfully!' });
      });
    });
  });
});


app.delete('/api/hospitals/:hospitalId/delete-bin', (req, res) => {
  const { hospitalId } = req.params;
  const { binReference } = req.body;

  if (!binReference) {
    return res.status(400).json({ message: 'Bin reference is required' });
  }

  const getBinQuery = `SELECT id FROM smart_trash_bin WHERE reference = ?`;

  db.query(getBinQuery, [binReference], (err, result) => {
    if (err) {
      console.error("Error fetching bin:", err);
      return res.status(500).json({ message: 'Error fetching bin' });
    }

    if (result.length === 0) {
      return res.status(404).json({ message: 'Bin not found' });
    }

    const binId = result[0].id;

    const query = `UPDATE smart_trash_bin SET hospital_id = NULL WHERE id = ?`;

    db.query(query, [binId], (err, result) => {
      if (err) {
        console.error("Error deleting bin:", err);
        return res.status(500).json({ message: 'Error deleting bin' });
      }

      const notificationQuery = `
        INSERT INTO notifications ( type, title, description, is_unread, posted_at, forrr) 
        VALUES ( ?, ?, ?, ?, NOW(), ?)`;

      const notificationData = [
        'system', 
        `Bin removed from hospital`, 
        `Bin with reference ${binReference} has been removed from hospital ID ${hospitalId}.`, 
        1, 'manager'
      ];

      db.query(notificationQuery, notificationData, (err) => {
        if (err) {
          console.error("Error inserting notification:", err);
          return res.status(500).json({ message: "Error inserting notification into database" });
        }
        res.status(200).json({ message: 'Bin deleted from hospital successfully!' });
      });
    });
  });
});


app.get('/api/smart-trash-bin/types', (req, res) => {
  const query = 'SELECT CAST(type AS CHAR) AS type, COUNT(*) AS count FROM smart_trash_bin GROUP BY type';

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching data from database:', err);
      return res.status(500).json({ message: 'Error fetching data from the database' });
    }

    res.json(results);
  });
});

app.get('/api/notifications', (req, res) => {
  const query = 'SELECT * FROM notifications ORDER BY posted_at DESC';

  db.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching notifications:', error);
      return res.status(500).send('Server error');
    }
    res.json(results); 
  });
});


app.put('/api/notifications/:id', (req, res) => {
  const { id } = req.params;
  const query = 'UPDATE notifications SET is_unread = 0 WHERE id = ?';
  db.query(query, [id], (error, results) => {
    if (error) {
      console.error('Error updating notification:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    res.status(200).json({ message: 'Notification marked as read' });
  });
});

function generateUserCode(length = 12) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

app.post('/signup', (req, res) => {
  console.log("Signup route hit"); 

  const { full_name, email, password, confirm_password } = req.body;

  if (password !== confirm_password) {
    return res.status(400).json({ message: "Passwords do not match" });
  }

  const user_code = generateUserCode(); // Generate code

  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) {
      return res.status(500).json({ message: "Error hashing password" });
    }

    const query = `
      INSERT INTO users (email, password, full_name, created_at, updated_at, giftpoints, nb_trashthrown, isbanned, role, user_code) 
      VALUES (?, ?, ?, NOW(), NOW(), 0, 0, 1, 'user', ?)`;

    db.query(query, [email, hashedPassword, full_name, user_code], (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Error inserting user into database" });
      }

      const userId = result.insertId;

      const notificationQuery = `
        INSERT INTO notifications ( type, title, description, is_unread, posted_at , forrr) 
        VALUES (?, ?, ?, ?, NOW(), ?)`;

      const notificationData = [
        'mail', 
        `Welcome, ${full_name}`, 
        `New user ${full_name} has signed up`, 
        1,
        full_name
      ];

      db.query(notificationQuery, notificationData, (err) => {
        if (err) {
          console.error("Error inserting notification:", err);
          return res.status(500).json({ message: "Error inserting notification into database" });
        }

        // ✅ Send the user_code in the response
        res.status(201).json({ 
          message: "User registered successfully", 
          user_code: user_code 
        });
      });
    });
  });
});



app.put('/api/users/:id/status', (req, res) => {
  const { id } = req.params;
  const { isbanned } = req.body;

  if (typeof isbanned !== 'boolean') {
    return res.status(400).json({ message: 'Invalid isbanned value' });
  }

  const query = 'UPDATE users SET isbanned = ? WHERE id = ?';
  db.query(query, [isbanned ? 1 : 0, id], (err, result) => {
    if (err) {
      console.error('Error updating user status:', err);
      return res.status(500).json({ message: 'Server error' });
    }

    const statusText = isbanned ? 'banned' : 'unbanned';

    const notificationQuery = `
      INSERT INTO notifications ( type, title, description, is_unread, posted_at , forrr) 
      VALUES ( ?, ?, ?, ?, NOW(), ?)`;

    const notificationData = [
      'system', 
      `User status updated`, 
      `User with ID ${id} has been ${statusText}.`, 
      1, 'admin'
    ];

    db.query(notificationQuery, notificationData, (err) => {
      if (err) {
        console.error("Error inserting notification:", err);
        return res.status(500).json({ message: "Error inserting notification into database" });
      }
      res.status(200).json({ message: `User status updated to ${statusText}` });
    });
  });
});

app.get('/api/user/name/:name', (req, res) => {
  const userName = req.params.name;
  const query = 'SELECT email, full_name, giftpoints, nb_trashthrown FROM users WHERE full_name = ?';

  db.query(query, [userName], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (result.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(result[0]);
  });
});

app.put('/apii/user/update', (req, res) => {
  const { id, email, password, full_name, giftpoints, nb_trashthrown } = req.body;

  const query = `
    UPDATE users
    SET email = ?, password = ?, full_name = ?, giftpoints = ?, nb_trashthrown = ?, updated_at = NOW()
    WHERE id = ?
  `;

  db.query(query, [email, password, full_name, giftpoints, nb_trashthrown, id], (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to update user data' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User data updated successfully' });
  });
});

// Fetch user's profile image by email
app.get('/user/:email/profile-image', (req, res) => {
    const { email } = req.params; // Get the email from the route parameter

    // Query to fetch user details, including the profile_image
    db.query('SELECT profile_image FROM users WHERE email = ?', [email], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Construct the full URL or path for the profile image
        const profileImagePath = `${req.protocol}://${req.get('host')}/uploads/${results[0].profile_image}`;

        res.json({
            profile_image: profileImagePath // Return the complete image URL
        });
    });
});


app.listen(7001 , ()=> {
    console.log("listening.");

});
