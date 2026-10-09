import { useNavigate } from "react-router";

import { InnerPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { useAuth } from "../auth/AuthProvider.js";
import { useLedger } from "../lib/queries.js";

/**
 * The book this account owns.
 *
 * v1 gives everybody exactly one, so this screen mostly states a fact. It
 * exists anyway because the concept has to be visible before sharing arrives —
 * "who can see this ledger" is the question v2 answers, and it needs a place
 * to be asked.
 */
export function BooksPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const ledger = useLedger();

  return (
    <InnerPage
      title="我的账本"
      subtitle="一个账号对应一本账本。多人共同记账功能尚未开放。"
      backTo="/me"
    >
      {ledger.isPending ? <SkeletonRows rows={2} /> : null}

      {ledger.isSuccess ? (
        <div className="rounded-card border border-line bg-surface p-5">
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 text-sm">
            <dt className="text-muted">账本名称</dt>
            <dd className="text-right text-ink">{ledger.data.book.name}</dd>

            <dt className="text-muted">所有者</dt>
            <dd className="text-right text-ink">{user?.displayName ?? ""}</dd>

            <dt className="text-muted">成员数</dt>
            <dd className="text-right text-ink">1</dd>
          </dl>

          <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
            账本改名、成员管理与协作邀请将在协作功能中开放。
          </p>
        </div>
      ) : null}
    </InnerPage>
  );
}
