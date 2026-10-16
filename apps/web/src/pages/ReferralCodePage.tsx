import { Card } from "../components/Card.js";
import { InnerPage } from "../components/Layouts.js";
import { ReferralCodeSection } from "../components/ReferralCodeSection.js";

/**
 * **邀请码 —— 账号级功能，现在有了自己的一页。**
 *
 * ⚠️ **The owner's instruction (2026-10-13)**: *"账户里边生成邀请码单独包装成一个入口，放到设置-账号安全里面."*
 *
 * ⚠️ **It used to be a block sitting inline on 账户**, which was already one move better than its
 * first home — it started on the *collaboration* screen, and the owner moved it off there himself:
 * *"前者属于账号级功能，适合放在「账户」的相关设置中，不需要占据当前账本的协作页面."*
 *
 * ⚠️ **Why a page rather than a block.** The section is not one fact and one button — it is a
 * lifetime quota, a mint action with a confirmation step, a code to copy, and two paragraphs
 * separating referral codes from ledger invitations. **Inline, that competes with the account
 * screen's own list**; behind 账号安全 it sits with 更改密码 and 恢复码, which are the other things
 * that are about *the account* rather than about any ledger. **That is the category it belongs to**,
 * and the owner naming 账号安全 is him drawing the same line.
 *
 * ⚠️ **One component, moved rather than copied.** `ReferralCodeSection` holds all the behaviour and
 * is rendered here unchanged — **a second implementation on both screens is how the two would come
 * to disagree about a quota** (`教训.md` §8.12).
 */
export function ReferralCodePage(): React.JSX.Element {
  return (
    <InnerPage
      title="邀请码"
      subtitle="用于邀请他人注册 Libevra，不会自动加入账本。"
      backTo="/settings"
    >
      <Card>
        <ReferralCodeSection />
      </Card>

      {/**
        * ⚠️ **The distinction is restated on the page itself, not only in the section.** A referral
        * code creates a **new account**; a ledger invitation adds **an existing account to one
        * ledger**. The two are easy to confuse and behave nothing alike, so the page that shows the
        * first says where the second lives — and it is now literally true: 邀请成员 is in the ledger,
        * and there is no longer a screen in between.
        */}
      <p className="text-helper-relaxed text-muted">
        想请别人一起记某一本账，用账本里的「邀请成员」——那是加入账本，不是注册账号。
        也可以从账本详情里生成分享链接，让别人自己点进来。
      </p>
    </InnerPage>
  );
}
