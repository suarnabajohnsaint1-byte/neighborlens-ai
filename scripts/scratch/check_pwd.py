import sqlite3
import bcrypt

def check_passwords():
    conn = sqlite3.connect("server/neighborlens.db")
    cur = conn.cursor()
    cur.execute("SELECT id, username, password_hash, role FROM users WHERE username IN ('admin', 'citizen')")
    rows = cur.fetchall()
    for uid, uname, phash, role in rows:
        print(f"User: {uname} (role: {role})")
        # test admin123
        try:
            if bcrypt.checkpw(b"admin123", phash.encode()):
                print(f"  Matches 'admin123'")
            elif bcrypt.checkpw(b"1", phash.encode()):
                print(f"  Matches '1'")
            elif bcrypt.checkpw(b"password", phash.encode()):
                print(f"  Matches 'password'")
            elif bcrypt.checkpw(b"citizen123", phash.encode()):
                print(f"  Matches 'citizen123'")
            else:
                print(f"  Hash: {phash[:20]}...")
        except Exception as e:
            print(f"  Error checking hash: {e}")
            
    conn.close()

if __name__ == "__main__":
    check_passwords()
