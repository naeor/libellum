-- Give accounts that predate the ledger tables the same data a new signup gets.
--
-- The `ledger_core` migration created books, categories and payment methods,
-- and registration was changed to populate them — but accounts created before
-- that change were left with nothing. They could sign in and then fail every
-- ledger request with "找不到你的账本", which is exactly what happened to the
-- owner's own account.
--
-- Every statement is guarded by NOT EXISTS, so this is safe to run against a
-- database where some accounts are already complete, and safe to re-run.

-- 1. A book for every account that has none.
INSERT INTO "books" ("id", "name", "created_by", "created_at", "updated_at")
SELECT gen_random_uuid(), '我的账本', u."id", now(), now()
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "books" b WHERE b."created_by" = u."id");

-- 2. Its owner membership.
INSERT INTO "book_members" ("book_id", "user_id", "role", "joined_at")
SELECT b."id", b."created_by", 'owner', now()
FROM "books" b
WHERE NOT EXISTS (
  SELECT 1 FROM "book_members" m
  WHERE m."book_id" = b."id" AND m."user_id" = b."created_by"
);

-- 3. The preset categories: 9 expense + 暂无分类, 6 income + 暂无分类.
INSERT INTO "categories"
  ("id", "book_id", "name", "kind", "sort_order", "is_archived", "is_system", "created_at", "updated_at")
SELECT gen_random_uuid(), b."id", c."name", c."kind"::"TransactionKind", c."sort_order", false, c."is_system", now(), now()
FROM "books" b
CROSS JOIN (VALUES
  ('餐饮',     'expense', 0, false),
  ('娱乐',     'expense', 1, false),
  ('服务',     'expense', 2, false),
  ('购物',     'expense', 3, false),
  ('教育',     'expense', 4, false),
  ('转账',     'expense', 5, false),
  ('生活缴费', 'expense', 6, false),
  ('交通',     'expense', 7, false),
  ('其他',     'expense', 8, false),
  ('暂无分类', 'expense', 9, true),
  ('转账',     'income',  0, false),
  ('工资',     'income',  1, false),
  ('奖金',     'income',  2, false),
  ('理财',     'income',  3, false),
  ('退款',     'income',  4, false),
  ('其他',     'income',  5, false),
  ('暂无分类', 'income',  6, true)
) AS c("name", "kind", "sort_order", "is_system")
WHERE NOT EXISTS (SELECT 1 FROM "categories" x WHERE x."book_id" = b."id");

-- 4. The default payment methods.
INSERT INTO "payment_methods"
  ("id", "book_id", "name", "sort_order", "is_archived", "created_at", "updated_at")
SELECT gen_random_uuid(), b."id", p."name", p."sort_order", false, now(), now()
FROM "books" b
CROSS JOIN (VALUES
  ('微信', 0), ('支付宝', 1), ('银行卡', 2), ('现金', 3), ('其他', 4)
) AS p("name", "sort_order")
WHERE NOT EXISTS (SELECT 1 FROM "payment_methods" x WHERE x."book_id" = b."id");
