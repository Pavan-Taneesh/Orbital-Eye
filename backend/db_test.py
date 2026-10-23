from db import get_connection

conn = get_connection()

cur = conn.cursor()
cur.execute("SELECT version();")
result = cur.fetchone()

print("Connected! Postgres version:")
print(result)

cur.close()
conn.close()
