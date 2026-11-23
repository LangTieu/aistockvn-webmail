// R2 billing HARD guard — worker/r2-guard.ts (20/11/2026, Henrry 19:08).
//
// R2 là dịch vụ DUY NHẤT trên tài khoản Skillshare01br có thể TỰ TÍNH TIỀN
// khi vượt mức free (subscription `r2_paid` đang active; vượt 10 GB-month /
// 1M Class A / 10M Class B thì trừ tiền theo giá niêm yết). Workers, D1,
// Workers AI và Observability đều hard-cap trên Free (vượt thì fail/chặn,
// KHÔNG trừ tiền) nên không cần rào dừng ghi ở đó — monitor báo động là đủ.
//
// Cơ chế rào cứng: mỗi lần ingest ghi 1 file .eml vào R2 thì cộng dồn vào
// bảng `r2_usage` (migration 0019). Chạm ngưỡng thì `blocked` = 1 và
// ingestInbound DỪNG ghi R2 — mail vẫn lưu D1 (chỉ thiếu file raw .eml),
// không để vượt rồi mới báo. Ngưỡng đặt ở 80% mức free để còn 2 GB headroom
// hấp thụ race giữa các lần ingest đồng thời.
//
// Fail-open: mọi lỗi D1 / bảng chưa có (migration chưa apply) đều cho phép
// ghi R2 — rào bảo vệ không bao giờ được làm hỏng việc nhận mail.

export const R2_STORAGE_HARD_CAP_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB = 80% of 10 GB free
export const R2_CLASS_A_HARD_CAP_MONTH = 800_000; // 80% of 1,000,000 Class A ops/month
export const R2_GUARD_TABLE = "r2_usage";

export interface R2Usage {
  bytes_total: number;
  objects_total: number;
  class_a_month: string; // YYYY-MM
  class_a_count: number;
  blocked: number; // 0 | 1
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getR2Usage(db: D1Database): Promise<R2Usage | null> {
  try {
    const row = await db
      .prepare(
        `SELECT bytes_total, objects_total, class_a_month, class_a_count, blocked FROM ${R2_GUARD_TABLE} WHERE id = 1`,
      )
      .first<R2Usage>();
    return row ?? null;
  } catch {
    return null; // table missing / DB error -> guard inert (fail-open)
  }
}

/** True khi đã chạm ngưỡng cứng (đã block, hoặc counter đã vượt ngưỡng dù flag chưa set). */
export async function isR2WriteBlocked(db: D1Database): Promise<boolean> {
  const usage = await getR2Usage(db);
  if (!usage) return false;
  if (usage.blocked) return true;
  if (usage.bytes_total >= R2_STORAGE_HARD_CAP_BYTES) return true;
  if (usage.class_a_month === currentMonth() && usage.class_a_count >= R2_CLASS_A_HARD_CAP_MONTH) return true;
  return false;
}

/** Ghi nhận 1 lần PUT R2 (1 Class A op). Tự set blocked=1 khi chạm ngưỡng. Fail-open: không bao giờ throw. */
export async function recordR2Write(db: D1Database, bytes: number): Promise<void> {
  try {
    const month = currentMonth();
    const usage = await getR2Usage(db);
    if (!usage) {
      await db
        .prepare(
          `INSERT INTO ${R2_GUARD_TABLE} (id, bytes_total, objects_total, class_a_month, class_a_count, blocked, updated_at)
           VALUES (1, ?, 1, ?, 1, ?, ?)`,
        )
        .bind(bytes, month, bytes >= R2_STORAGE_HARD_CAP_BYTES ? 1 : 0, Date.now())
        .run();
      return;
    }
    const bytesTotal = usage.bytes_total + bytes;
    const objectsTotal = usage.objects_total + 1;
    const classACount = usage.class_a_month === month ? usage.class_a_count + 1 : 1;
    const blocked =
      bytesTotal >= R2_STORAGE_HARD_CAP_BYTES || classACount >= R2_CLASS_A_HARD_CAP_MONTH ? 1 : usage.blocked;
    await db
      .prepare(
        `UPDATE ${R2_GUARD_TABLE} SET bytes_total = ?, objects_total = ?, class_a_month = ?, class_a_count = ?, blocked = ?, updated_at = ? WHERE id = 1`,
      )
      .bind(bytesTotal, objectsTotal, month, classACount, blocked, Date.now())
      .run();
  } catch {
    // Fail-open: counter lỗi thì bỏ qua, không làm hỏng ingest.
  }
}
