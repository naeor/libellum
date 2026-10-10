/**
 * Picking a category from what was said.
 *
 * The owner's request: **"可以再补充一些逻辑，比如说检测到对话食物的时候。如果
 * 分类里有餐饮，就选餐饮等等."**
 *
 * ⚠️ **It only picks a category that already exists, and it says what it matched
 * on.** Both rules come from one concern.
 *
 * **Never invent a category.** The categories belong to the user and they rename
 * them; a guess that created "餐饮" in a ledger whose owner calls it "吃饭" would be
 * the app deciding something that is not its to decide. So this matches against
 * the list it is given and returns `null` when nothing fits — and `null` is a
 * perfectly good answer, because the category field is one tap away.
 *
 * **Never guess silently.** The result carries the words that matched, so the
 * interface can say "听到「午饭」，已选：餐饮" rather than quietly filling a field.
 * The amount is shown for this reason; a silently-chosen category is the same
 * failure in a different field.
 *
 * The vocabularies are deliberately short. A long list matches more and is wrong
 * more: 「水」 appears in 水果, 水费 and 水瓶, so it is listed only where the words
 * around it carry the meaning.
 */

/** What the matcher needs to know about a category. */
export interface CategoryCandidate {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly isArchived: boolean;
}

export interface CategoryMatch {
  readonly id: string;
  /** The words that matched, so the interface can show its reasoning. */
  readonly matched: readonly string[];
}

/**
 * The words that suggest each kind of spending, keyed by an internal subject
 * name.
 *
 * ⚠️ **The later argument is `aliases` and the earlier one is not.** The first
 * version tried to derive the subject from the key by substring containment, which
 * cannot work: a category the owner calls 吃饭 is not a substring of the key 餐饮,
 * and neither contains the other. **A subject and its synonyms have no textual
 * relationship**, so the synonyms have to be listed. That is what `aliases` is —
 * the names this subject goes by in somebody's ledger.
 */
const VOCABULARY: Readonly<Record<string, { readonly aliases: readonly string[]; readonly words: readonly string[] }>> = {
  餐饮: {
    aliases: ["餐饮", "吃饭", "吃的", "伙食", "美食", "食物", "食品"],
    words: [
      "午饭", "晚饭", "早饭", "早餐", "午餐", "晚餐", "夜宵", "宵夜", "吃饭", "吃了", "吃个",
      "外卖", "点餐", "餐厅", "饭店", "饭馆", "食堂", "火锅", "烧烤", "拉面", "米饭", "面条",
      "包子", "饺子", "快餐", "奶茶", "咖啡", "饮料", "零食", "水果", "买菜", "下馆子",
    ],
  },
  交通: {
    aliases: ["交通", "出行", "通勤", "车费", "路费"],
    words: [
      "打车", "出租车", "网约车", "滴滴", "公交", "地铁", "火车", "高铁", "动车", "机票",
      "飞机", "加油", "油费", "停车", "过路费", "高速费", "共享单车", "单车", "车票", "路费",
    ],
  },
  购物: {
    aliases: ["购物", "买东西", "逛街", "日用", "服饰", "百货"],
    words: [
      "网购", "淘宝", "京东", "拼多多", "下单", "商场", "超市", "衣服", "鞋子", "裤子",
      "包包", "化妆品", "护肤品", "日用品", "洗发水", "纸巾", "快递",
    ],
  },
  居住: {
    aliases: ["居住", "住房", "房租", "物业", "家电", "家用"],
    words: ["房租", "水电", "水电费", "水费", "电费", "燃气", "物业", "取暖", "暖气", "宽带", "网费"],
  },
  通讯: {
    aliases: ["通讯", "话费", "通信", "手机费"],
    words: ["话费", "流量", "手机费", "电话费", "套餐"],
  },
  医疗: {
    aliases: ["医疗", "看病", "医药", "健康"],
    words: ["看病", "医院", "挂号", "买药", "药费", "体检", "牙医", "门诊", "住院"],
  },
  娱乐: {
    aliases: ["娱乐", "休闲", "玩乐", "爱好"],
    words: ["电影", "游戏", "KTV", "旅游", "门票", "演唱会", "视频会员"],
  },
  教育: {
    aliases: ["教育", "学习", "培训", "书"],
    words: ["学费", "买书", "培训", "课程", "考试", "报名费", "文具"],
  },
  人情: {
    aliases: ["人情", "礼金", "礼物", "社交"],
    words: ["红包", "随礼", "份子钱", "送礼"],
  },
  宠物: {
    aliases: ["宠物", "猫", "狗"],
    words: ["猫粮", "狗粮", "宠物", "兽医", "猫砂"],
  },
};

/** The words that suggest money coming in, with the categories they belong to. */
const INCOME_VOCABULARY = {
  aliases: ["工资", "薪水", "收入", "奖金", "报销", "退款", "兼职", "外快", "理财", "分红", "利息"],
  words: ["工资", "薪水", "月薪", "奖金", "报销", "退款", "分红", "利息", "收到", "入账", "到账"],
};

/**
 * Whether a category is "about" a subject.
 *
 * Containment in either direction against the subject's **aliases**, which is what
 * makes this work with names nobody anticipated:
 *
 *  * `name.includes(alias)` — a category named 餐饮美食 is about the 餐饮 subject;
 *  * `alias.includes(name)` — a category named 吃 is about it too.
 *
 * The aliases are why a category called 吃饭 matches: 吃饭 is listed as an alias of
 * the food subject, so the containment test has something to succeed against.
 * Deriving the subject from the key instead was the first version's mistake —
 * **a subject and its synonyms have no textual relationship.**
 */
function isAbout(name: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => name.includes(alias) || alias.includes(name));
}

/**
 * Find the category that fits what was said.
 *
 * Returns `null` when nothing matches — treat that as "leave it to the user", not
 * as a failure.
 */
export function matchCategory(
  spoken: string,
  categories: readonly CategoryCandidate[],
  kind: "expense" | "income",
): CategoryMatch | null {
  if (spoken.trim() === "") return null;

  /**
   * Only categories of the right kind.
   *
   * The API refuses a category whose kind disagrees with the entry — "「转账」属于
   * 收入分类，和这笔记账的收支类型不一致" — so offering one would produce a rejection
   * the user cannot explain.
   */
  const usable = categories.filter(
    (category) => category.kind === kind && !category.isArchived && category.name.trim() !== "",
  );

  if (usable.length === 0) return null;

  /**
   * The vocabularies to search, worked out once.
   *
   * For spending, every heading in the table — each is filtered per category by
   * whether the category is about it. For income, the income words **and** every
   * heading: somebody whose category is called 工资 must still match the word
   * 工资, and somebody whose income category is called 兼职 should still match
   * 报销 because 报销 is what they said. Doing it as a list rather than as nested
   * conditions is what stopped the first version from silently searching nothing
   * in the income case.
   */
  /**
   * The vocabularies to search, worked out once.
   *
   * For spending: every subject, each filtered per category by whether the
   * category is about it. For income: the income subject as well, so that 工资 and
   * 报销 are reachable whichever an income category is named after.
   */
  const subjects: readonly (readonly [string, { readonly aliases: readonly string[]; readonly words: readonly string[] }])[] =
    kind === "income"
      ? [...Object.entries(VOCABULARY), ["收入", INCOME_VOCABULARY] as const]
      : Object.entries(VOCABULARY);

  let best: { readonly match: CategoryMatch; readonly score: number } | null = null;

  for (const category of usable) {
    /**
     * Evidence, counting **occurrences rather than distinct words**.
     *
     * "打车去吃饭，打车回来的" is a sentence about transport, and counting each word
     * once made it a tie with food. Somebody who says 打车 twice has told you which
     * category it is.
     *
     * ⚠️ `includes` is a boolean, so the first version of this loop voted once per
     * **word** and never once per **occurrence** — the comment above it said
     * "occurrences" while the code said "words". The test caught the difference;
     * a comment cannot.
     */
    const evidence = new Map<string, number>();

    const vote = (word: string): void => {
      let count = 0;
      let at = spoken.indexOf(word);

      while (at !== -1) {
        count += 1;
        at = spoken.indexOf(word, at + word.length);
      }

      if (count > 0) evidence.set(word, count);
    };

    for (const [, subject] of subjects) {
      // Only a category that is *about* this subject votes on its words.
      if (!isAbout(category.name, subject.aliases)) continue;

      for (const word of subject.words) vote(word);
    }

    // The category's own name, said out loud: "餐饮三十八". Counted as two votes,
    // because hearing the category named is the strongest evidence there is.
    if (category.name.length >= 2 && spoken.includes(category.name)) {
      evidence.set(category.name, (evidence.get(category.name) ?? 0) + 2);
    }

    let score = 0;
    for (const count of evidence.values()) score += count;

    if (score > 0 && (best === null || score > best.score)) {
      best = { match: { id: category.id, matched: [...evidence.keys()] }, score };
    }
  }

  return best?.match ?? null;
}
