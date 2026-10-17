import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **系统管理的接线（S13-B/C）—— 页面写好了，但它曾经没有一条路能走到。**
 *
 * ⚠️ **这是这次修复的真正内容，所以测试断言的正是"接上了没有"。**
 * `pages/AdminPages.tsx` 的五个页面组件与 `lib/admin.ts` 的十个请求早已存在，`App` 顶部也
 * 早已 import 了它们——**但路由表里一条 `/admin*` 都没有**，通配路由把它们送回首页。
 * 一屏代码完整却无法抵达，是任何"能渲染"的单元测试都发现不了的失败。
 *
 * ⚠️ **断言源码而不是渲染，因为这个项目的网页测试跑在没有 DOM 的纯 Node 里**
 * （`vitest.config.ts`），和 `lib/backNavigation.test.ts`、`lib/copy.test.ts` 是同一个选择。
 */
function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/** 五个条目，顺序与路由表一致：地址 → 页面组件。 */
const ADMIN_ROUTES = [
  ["/admin", "AdminOverviewPage"],
  ["/admin/invites", "AdminInvitesPage"],
  ["/admin/admins", "AdminAdminsPage"],
  ["/admin/users", "AdminUsersPage"],
  ["/admin/audit", "AdminAuditPage"],
] as const;

describe("系统管理的路由", () => {
  it("五个地址各自有一条 Route，并且在 RequireAuth 之内", () => {
    const app = source("../App.tsx");

    for (const [path, page] of ADMIN_ROUTES) {
      /**
       * ⚠️ **登录检查写在路由这一层**：没登录的人看到的是登录页，而不是一个向
       * `/admin/self` 发出 401 请求的空白屏。权限检查不在这里——见下一个用例。
       */
      expect(app, path).toContain(
        `<Route path="${path}" element={<RequireAuth><${page} /></RequireAuth>} />`,
      );
    }
  });

  it("排在通配路由之前，否则仍然会被送回首页", () => {
    const app = source("../App.tsx");

    const wildcard = app.indexOf('path="*"');
    expect(wildcard).toBeGreaterThan(-1);

    for (const [path] of ADMIN_ROUTES) {
      const route = app.indexOf(`path="${path}"`);
      expect(route, path).toBeGreaterThan(-1);
      expect(route, path).toBeLessThan(wildcard);
    }
  });

  it("不自己复制授权规则，把判断留给页面和服务器", () => {
    const app = source("../App.tsx");

    /**
     * ⚠️ **路由层只包 `RequireAuth`，不包任何"是不是管理员"的东西。** 在浏览器里藏一个入口
     * 从不能让端点变安全，反过来也一样：第二个判断点正是这个项目记在案上的"洞是怎么出现的"。
     * 所以路由文件既不问管理员接口，也不复制号段规则——**它只负责把地址接到页面上**。
     *
     * ⚠️ 注释里提到 `useAdminGate` 是说明"判断在哪"，不算复制；这里禁的是**调用**。
     */
    expect(app).not.toContain("fetchAdminSelf");
    expect(app).not.toContain("mayHoldAdministration");
    expect(app).not.toContain("isFirstBatchAccountNumber");
  });
});

describe("非管理员直达 /admin 不会白屏", () => {
  const pages = source("./AdminPages.tsx");

  it("拒绝时把页面换到 /me，而不是留下一个空壳", () => {
    /**
     * ⚠️ **两条拒绝路径都要走**：服务器回答"不是"（`self === null`）与请求本身失败。
     * 只处理前者的话，一次网络错误就会把非管理员留在 `/admin` 的空白页上。
     */
    const redirects = pages.match(/navigate\("\/me", \{ replace: true \}\)/g) ?? [];
    expect(redirects).toHaveLength(2);
  });

  it("答案还没回来时渲染骨架屏，只有明确允许才渲染内容", () => {
    /**
     * ⚠️ **`allowed === true` 是唯一放行的条件**：`null`（还在问）和 `false`（拒绝）都不是。
     * 这既避免了闪一下管理界面，也让"直达"这三个状态里没有一个会渲染成空。
     */
    expect(pages).toContain("{allowed === true ? children : <SkeletonRows rows={4} />}");
  });
});

describe("设置页的「系统管理」入口", () => {
  const settings = source("./SettingsPage.tsx");

  it("用 useAdminEntry 判断，且只看得到这一组的人才渲染", () => {
    /**
     * ⚠️ **两个便宜的条件都在 hook 里**：账号编号不在首批号段就**不发请求**（普通账号连
     * 这组的存在都看不到），在号段里也还要服务器确认一次。这里断言的是设置页**确实问了**，
     * 并且把结果当作渲染条件，而不是无条件列出五个入口。
     */
    expect(settings).toContain("useAdminEntry(user?.accountNumber)");
    expect(settings).toContain("{isAdmin ? (");
  });

  it("五个入口都指向真实存在的路由，且分组在「关于」之前", () => {
    for (const [path] of ADMIN_ROUTES) {
      expect(settings, path).toContain(`to: "${path}"`);
    }

    const gate = settings.indexOf("{isAdmin ? (");
    /** ⚠️ 匹配 JSX 标题本身（`>系统管理<`），而不是注释里出现的同一串字。 */
    const section = settings.indexOf(">系统管理<");
    const about = settings.indexOf(">关于<");

    expect(gate).toBeGreaterThan(-1);
    /** 条件在分组之前：否则「系统管理」标题会被无条件渲染出来。 */
    expect(section).toBeGreaterThan(gate);
    /** 「关于」保持最后一组，和改动前一致。 */
    expect(about).toBeGreaterThan(section);
  });
});
