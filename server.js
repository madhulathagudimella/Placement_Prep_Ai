const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'learnflow-secret-key',
    resave: false,
    saveUninitialized: true
}));

// Database Setup
const db = new sqlite3.Database('./learnflow.db', (err) => {
    if (err) {
        console.error("Error opening database " + err.message);
    } else {
        console.log("Connected to the SQLite database.");
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            weak_areas TEXT, -- JSON string of weak topics
            streak_count INTEGER DEFAULT 0,
            last_login TEXT
        )`);

        // Questions Table (Bank)
        db.run(`CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT, -- 'aptitude' or 'coding'
            topic TEXT, -- e.g., 'Time & Work', 'DP'
            difficulty TEXT, -- 'Easy', 'Medium', 'Hard'
            content TEXT,
            options TEXT, -- JSON for multiple choice
            solution TEXT
        )`);

        // Interviews Table (Mock Chats)
        db.run(`CREATE TABLE IF NOT EXISTS interviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            date TEXT,
            log_json TEXT, -- Full chat transcript
            score INTEGER,
            feedback TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        // Progress Table
        db.run(`CREATE TABLE IF NOT EXISTS user_progress (
            user_id INTEGER,
            question_id INTEGER,
            is_correct INTEGER,
            timestamp TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(question_id) REFERENCES questions(id)
        )`);

        // Courses Table
        db.run(`CREATE TABLE IF NOT EXISTS courses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            description TEXT
        )`);

        // Seed a default user if not exists
        db.get("SELECT * FROM users WHERE email = 'candidate@placeprep.com'", async (err, row) => {
            if (err) {
                console.error("Error checking user:", err);
            } else if (!row) {
                try {
                    const hashedPassword = await bcrypt.hash('password123', 10);
                    db.run(`INSERT INTO users (username, email, password, weak_areas, streak_count) 
                            VALUES ('Candidate', 'candidate@placeprep.com', ?, ?, 5)`, 
                           [hashedPassword, JSON.stringify(['Time & Work (Aptitude)', 'Recursion (Coding)'])],
                           (err) => {
                               if (err) console.error("Error seeding default user:", err.message);
                               else console.log("Seeded default user: candidate@placeprep.com / password123");
                           });
                } catch(e) {
                    console.error("Error hashing password during seed:", e);
                }
            }
        });
    });
}

// Authentication Middleware
const checkAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Unauthorized. Please log in." });
    }
    next();
};

// User Profile Endpoint
app.get('/api/me', checkAuth, (req, res) => {
    db.get("SELECT id, username, email, weak_areas, streak_count FROM users WHERE id = ?", [req.session.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        let weakAreas = [];
        try {
            weakAreas = JSON.parse(user.weak_areas || "[]");
        } catch(e) {
            weakAreas = [];
        }
        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            weak_areas: weakAreas,
            streak_count: user.streak_count
        });
    });
});

app.get('/api/courses', (req, res) => {
    db.all("SELECT * FROM courses", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Authentication Routes
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: "All fields are required" });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const defaultWeak = JSON.stringify(['Time & Work (Aptitude)', 'Recursion (Coding)']);
        db.run(`INSERT INTO users (username, email, password, weak_areas, streak_count) VALUES (?,?,?,?,?)`,
            [username, email, hashedPassword, defaultWeak, 1],
            function (err) {
                if (err) {
                    if (err.message.includes("UNIQUE")) {
                        return res.status(400).json({ error: "Username or email already exists" });
                    }
                    return res.status(400).json({ error: err.message });
                }
                req.session.userId = this.lastID;
                res.json({ id: this.lastID, username });
            }
        );
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
    }
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(400).json({ error: "User not found" });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Invalid password" });

        req.session.userId = user.id;
        
        // Update streak count (e.g., if last login was different day)
        const today = new Date().toISOString().split('T')[0];
        let newStreak = user.streak_count;
        if (user.last_login !== today) {
            newStreak = (user.streak_count || 0) + 1;
        }

        db.run("UPDATE users SET last_login = ?, streak_count = ? WHERE id = ?", [today, newStreak, user.id], (err) => {
            if (err) console.error("Error updating login date:", err);
            res.json({ 
                message: "Logged in successfully", 
                user: { id: user.id, username: user.username, streak: newStreak } 
            });
        });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: "Failed to log out" });
        res.json({ message: "Logged out successfully" });
    });
});

// Save Interview Results
app.post('/api/interviews', checkAuth, (req, res) => {
    const { score, feedback, log } = req.body;
    const date = new Date().toISOString().split('T')[0];
    db.run(`INSERT INTO interviews (user_id, date, score, feedback, log_json) VALUES (?, ?, ?, ?, ?)`,
        [req.session.userId, date, score, feedback, JSON.stringify(log || [])],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // If score is low in some areas, update user's weak areas list
            db.get("SELECT weak_areas FROM users WHERE id = ?", [req.session.userId], (err, user) => {
                if (user) {
                    let weak = [];
                    try { weak = JSON.parse(user.weak_areas || "[]"); } catch(e){}
                    
                    if (score < 75 && !weak.includes("OOP Concepts")) {
                        weak.push("OOP Concepts");
                        db.run("UPDATE users SET weak_areas = ? WHERE id = ?", [JSON.stringify(weak), req.session.userId]);
                    }
                }
            });

            res.json({ success: true, id: this.lastID });
        }
    );
});

// Retrieve Interview History
app.get('/api/interviews', checkAuth, (req, res) => {
    db.all("SELECT id, date, score, feedback FROM interviews WHERE user_id = ? ORDER BY id DESC", [req.session.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Save/Update Progress
app.post('/api/progress', checkAuth, (req, res) => {
    const { questionId, isCorrect, topic } = req.body;
    const timestamp = new Date().toISOString();
    
    db.run(`INSERT INTO user_progress (user_id, question_id, is_correct, timestamp) VALUES (?, ?, ?, ?)`,
        [req.session.userId, questionId, isCorrect ? 1 : 0, timestamp],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // If correct, remove from weak areas if it was there
            if (isCorrect && topic) {
                db.get("SELECT weak_areas FROM users WHERE id = ?", [req.session.userId], (err, user) => {
                    if (user) {
                        let weak = [];
                        try { weak = JSON.parse(user.weak_areas || "[]"); } catch(e){}
                        const filtered = weak.filter(w => !w.toLowerCase().includes(topic.toLowerCase()));
                        if (filtered.length !== weak.length) {
                            db.run("UPDATE users SET weak_areas = ? WHERE id = ?", [JSON.stringify(filtered), req.session.userId]);
                        }
                    }
                });
            }
            res.json({ success: true });
        }
    );
});

// Serve Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
