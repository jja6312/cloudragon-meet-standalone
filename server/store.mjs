import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
export function openStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, "meet.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks(meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, bytes INTEGER NOT NULL, hash TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(meeting_id,sequence));
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      task TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS budgets(day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,kind));`);
  db.prepare(
    "UPDATE jobs SET state='FAILED',error='서버가 재시작됐습니다. 다시 생성해 주세요.' WHERE state='RUNNING'",
  ).run();
  const get = (id) => {
    const row = db.prepare("SELECT body FROM meetings WHERE id=?").get(id);
    return row
      ? {
          ...JSON.parse(row.body),
          chunks: db
            .prepare(
              "SELECT sequence,bytes,hash FROM chunks WHERE meeting_id=? ORDER BY sequence",
            )
            .all(id),
          aiJob: db
            .prepare(
              "SELECT id,state,error FROM jobs WHERE meeting_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
            )
            .get(id),
        }
      : null;
  };
  return {
    db,
    get,
    save(meeting) {
      const { chunks, aiJob, ...body } = meeting;
      db.prepare(
        "INSERT INTO meetings(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      ).run(body.id, JSON.stringify(body));
    },
    remove(id) {
      db.prepare("DELETE FROM meetings WHERE id=?").run(id);
    },
    reserve(kind, limit) {
      const day = new Date().toISOString().slice(0, 10);
      db.prepare("DELETE FROM budgets WHERE day<>?").run(day);
      db.prepare(
        "INSERT INTO budgets(day,kind,count) VALUES(?,?,0) ON CONFLICT DO NOTHING",
      ).run(day, kind);
      return (
        db
          .prepare(
            "UPDATE budgets SET count=count+1 WHERE day=? AND kind=? AND count<?",
          )
          .run(day, kind, limit).changes === 1
      );
    },
    close() {
      db.close();
    },
  };
}
