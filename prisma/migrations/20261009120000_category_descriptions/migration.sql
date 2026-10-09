-- Give the preset categories the explanation they were always meant to carry.
--
-- The wording already existed in the server code, but was never stored, so the
-- interface had nothing to show. It now lives on the row itself.
--
-- Only the presets are filled in, and only where the name still matches: a
-- category the user has renamed to something of their own keeps a NULL
-- description and therefore no explanation button.

ALTER TABLE "categories" ADD COLUMN "description" TEXT;

UPDATE "categories"
SET "description" = CASE
  WHEN "kind" = 'expense' AND "name" = '餐饮'     THEN '日常用餐与饮品支出'
  WHEN "kind" = 'expense' AND "name" = '娱乐'     THEN '游戏、影音与休闲消费'
  WHEN "kind" = 'expense' AND "name" = '服务'     THEN '通信、会员及其他服务费用'
  WHEN "kind" = 'expense' AND "name" = '购物'     THEN '日用品与商品采购'
  WHEN "kind" = 'expense' AND "name" = '教育'     THEN '学费、课程与培训支出'
  WHEN "kind" = 'expense' AND "name" = '转账'     THEN '转给他人的款项'
  WHEN "kind" = 'expense' AND "name" = '生活缴费' THEN '房租、水电、物业等固定支出'
  WHEN "kind" = 'expense' AND "name" = '交通'     THEN '通勤、加油与出行费用'
  WHEN "kind" = 'expense' AND "name" = '其他'     THEN '未归入以上类别的支出'
  WHEN "kind" = 'income'  AND "name" = '转账'     THEN '他人转入的款项'
  WHEN "kind" = 'income'  AND "name" = '工资'     THEN '薪资与劳务报酬'
  WHEN "kind" = 'income'  AND "name" = '奖金'     THEN '年终奖及各类奖励'
  WHEN "kind" = 'income'  AND "name" = '理财'     THEN '投资、利息与分红收益'
  WHEN "kind" = 'income'  AND "name" = '退款'     THEN '退货及费用返还'
  WHEN "kind" = 'income'  AND "name" = '其他'     THEN '未归入以上类别的收入'
  ELSE NULL
END
WHERE "is_system" = false
  AND "description" IS NULL;
