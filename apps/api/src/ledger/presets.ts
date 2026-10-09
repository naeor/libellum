import { UNCATEGORISED_NAME, type TransactionKind } from "@libellum/shared";

/**
 * What a brand-new book starts with.
 *
 * The category list was decided by the project owner (2026-10-09). The
 * descriptions are written for end users: the owner's original examples were
 * only there to explain intent and are deliberately not reused verbatim.
 *
 * There are no icons in v1 — by decision, not by omission.
 */

export interface CategoryPreset {
  readonly name: string;
  readonly description: string;
}

export const EXPENSE_CATEGORIES: readonly CategoryPreset[] = [
  { name: "餐饮", description: "日常用餐与饮品支出" },
  { name: "娱乐", description: "游戏、影音与休闲消费" },
  { name: "服务", description: "通信、会员及其他服务费用" },
  { name: "购物", description: "日用品与商品采购" },
  { name: "教育", description: "学费、课程与培训支出" },
  { name: "转账", description: "转给他人的款项" },
  { name: "生活缴费", description: "房租、水电、物业等固定支出" },
  { name: "交通", description: "通勤、加油与出行费用" },
  { name: "其他", description: "未归入以上类别的支出" },
];

export const INCOME_CATEGORIES: readonly CategoryPreset[] = [
  { name: "转账", description: "他人转入的款项" },
  { name: "工资", description: "薪资与劳务报酬" },
  { name: "奖金", description: "年终奖及各类奖励" },
  { name: "理财", description: "投资、利息与分红收益" },
  { name: "退款", description: "退货及费用返还" },
  { name: "其他", description: "未归入以上类别的收入" },
];

export const PAYMENT_METHOD_NAMES: readonly string[] = ["微信", "支付宝", "现金", "其他"];

export function categoriesFor(kind: TransactionKind): readonly CategoryPreset[] {
  return kind === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
}

/**
 * The system category that collects entries saved without a choice.
 *
 * It is a real row rather than a null, which keeps `transactions.category_id`
 * mandatory and every entry countable — but it is hidden from the picker and
 * cannot be renamed, archived or deleted.
 */
export const UNCATEGORISED: CategoryPreset = {
  name: UNCATEGORISED_NAME,
  description: "未选择分类的记账",
};

export const DEFAULT_BOOK_NAME = "我的账本";
