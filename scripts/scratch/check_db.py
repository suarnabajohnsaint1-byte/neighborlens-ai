import sqlite3

def check_db_users():
    conn = sqlite3.connect("server/neighborlens.db")
    cur = conn.cursor()
    cur.execute("SELECT id, username, role, barangay, full_name FROM users")
    users = cur.fetchall()
    print("Users in server/neighborlens.db:")
    for u in users:
        print(f"  ID: {u[0]}, Username: {u[1]}, Role: {u[2]}, Barangay: {u[3]}, Name: {u[4]}")
        
    cur.execute("SELECT COUNT(*) FROM reports")
    report_count = cur.fetchone()[0]
    print(f"Total reports in db: {report_count}")
    conn.close()

if __name__ == "__main__":
    check_db_users()
