-- 每笔账目获得一个**给人看的编号**：`#000001`，每本账从 1 开始。
--
-- 所有者 2026-10-12 的原话：
--
-- > "给每一个账目一个独特编号。这个编号对于每一笔帐本都从 #000001 开始，总共 6 位数加一个 # 号，
-- >  每次加一……在明细界面不会直接这些编号，但点进每一笔账目之后……写出编号多少多少。
-- >  离线期间新增的账目不直接生成编号；**所有的编号都由服务器统一分配**……
-- >  编号不可被用户修改。另外一题，编号跟之前的账目内部 ID 是不一样的……
-- >  编号并不是像内部 ID 一样账目一生成就会拥有——**编号更多是给用户看的**。
-- >  **程序所有的操作仍然用内部 ID。**"
--
-- ⚠️ **两列，各管一件事，不能合并：**
--
-- | 列 | 在哪 | 是什么 |
-- |---|---|---|
-- | `transactions.seq` | 账目 | **已经分到的那个号**。这本账的第几笔，从 1 开始 |
-- | `books.next_transaction_seq` | 账本 | **下一个该发的号**。计数器，**每本账一个** |
--
-- ⚠️ **计数器不能从 `MAX(seq)` 现算。** 删掉的账目不释放号（编号是历史），
-- 所以"下一个号"不等于"最大号 + 1"——**它是独立的事实**，必须自己存着。
-- 这是 `教训.md` §8.12 那一类：一个事实不要在两处实现。
--
-- ⚠️ **也不能用全局的 `counters` 表**（账号编号和账本编号用的是那个）。
-- 所有者要的是"**每一笔帐本都从 #000001 开始**"——**每本账各自一套序列**，
-- 而全局计数器只能给出一串连续的号，无法按账本分段。
-- 计数器放在 `books` 行上还有一个好处：**取号就是锁住那一行**，
-- 同一本账的并发插入自然排队，不同账本互不阻塞。

-- ---------------------------------------------------------------------------
-- 1. 账目：编号列
-- ---------------------------------------------------------------------------
--
-- ⚠️ 先允许为空、回填、再设 NOT NULL。**一步 `NOT NULL` 会让本次迁移在有数据的库上直接失败。**

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "seq" INTEGER;

-- ---------------------------------------------------------------------------
-- 2. 给已有的账目编号
-- ---------------------------------------------------------------------------
--
-- ⚠️ **按 `occurred_at` 排序，而不是按入库时间。** 编号是发给用户看的，
-- 而"这笔发生的先后"才是用户心里的顺序——**按入库时间排，会把一批补录的历史账目排到最近几笔之后**，
-- 那看起来就像编号乱了。
--
-- ⚠️ **排序里带上 `id` 作为最后的 tie-break。** 同一秒可能有多笔（导入尤其如此），
-- 而**没有确定性的排序意味着两次执行给出不同结果**——那样这个迁移就不可重复验证，
-- 而"可重复执行"是这个项目对所有迁移的硬要求。
--
-- ⚠️ **每本账各自从 1 开始**：`PARTITION BY book_id`。

WITH ordered AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "book_id"
           ORDER BY "occurred_at", "created_at", "id"
         )::int AS number
  FROM "transactions"
)
UPDATE "transactions" AS t
SET "seq" = ordered.number
FROM ordered
WHERE t."id" = ordered."id" AND t."seq" IS NULL;

-- ⚠️ **设成 NOT NULL，因为"账目没有编号"在新世界里是不存在的状态**：
-- 服务器在插入那一刻就分配它（见 `allocateTransactionSeq`）。
-- 留成可空会让"没有编号"成为一种需要到处处理的可能，而它本不该存在。

ALTER TABLE "transactions" ALTER COLUMN "seq" SET NOT NULL;

-- ⚠️ **`(book_id, seq)` 唯一**——这才是"编号在账本内独一无二"的强制点。
-- 应用层算错了就会撞在这条约束上，**而不是悄悄发出两个 #000007**。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_book_seq_key') THEN
    ALTER TABLE "transactions"
      ADD CONSTRAINT "transactions_book_seq_key" UNIQUE ("book_id", "seq");
  END IF;
END $$;

-- ⚠️ 编号从 1 开始，所以 0 和负数都是错的。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_seq_positive') THEN
    ALTER TABLE "transactions"
      ADD CONSTRAINT "transactions_seq_positive" CHECK ("seq" >= 1);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. 账本：下一个该发的号
-- ---------------------------------------------------------------------------
--
-- ⚠️ 默认 1，所以**新账本的第一笔就是 #000001**——正是所有者说的。
-- 回填放在下一步，因为已有账本的计数要接在已发出去的号之后。

ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "next_transaction_seq" INTEGER NOT NULL DEFAULT 1;

-- ⚠️ **计数器必须大于已发出去的最大号**，否则新账目会撞上唯一约束。
-- 对没有账目的账本，`COALESCE(..., 0) + 1` 正好是 1。
--
-- ⚠️ **它是"下一个该发的"，不是"已经发了几个"**：删掉的号不回收，
-- 所以这里用的是 `MAX(seq) + 1`，而不是 `COUNT(*) + 1`。
UPDATE "books" AS b
SET "next_transaction_seq" = COALESCE(
  (SELECT MAX(t."seq") FROM "transactions" AS t WHERE t."book_id" = b."id"),
  0
) + 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_next_transaction_seq_positive') THEN
    ALTER TABLE "books"
      ADD CONSTRAINT "books_next_transaction_seq_positive" CHECK ("next_transaction_seq" >= 1);
  END IF;
END $$;
