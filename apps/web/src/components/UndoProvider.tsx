import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { UndoBar } from "./UndoBar.js";

interface UndoRequest {
  readonly message: string;
  readonly onUndo: () => void | Promise<void>;
}

interface UndoContextValue {
  /** Offer a short window to take something back. */
  showUndo(request: UndoRequest): void;
}

const UndoContext = createContext<UndoContextValue | null>(null);

/**
 * Holds the "撤销" bar above the whole application rather than inside a page.
 *
 * That matters: deleting an entry sends the user back to the list, and the
 * offer to undo has to survive that navigation. A bar owned by the page it was
 * triggered from would vanish with the page.
 */
export function UndoProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [request, setRequest] = useState<UndoRequest | null>(null);

  const showUndo = useCallback((next: UndoRequest) => {
    setRequest(next);
  }, []);

  const dismiss = useCallback(() => {
    setRequest(null);
  }, []);

  const value = useMemo<UndoContextValue>(() => ({ showUndo }), [showUndo]);

  return (
    <UndoContext.Provider value={value}>
      {children}
      {request ? (
        <UndoBar
          message={request.message}
          onAction={() => {
            setRequest(null);
            void request.onUndo();
          }}
          onDismiss={dismiss}
        />
      ) : null}
    </UndoContext.Provider>
  );
}

export function useUndo(): UndoContextValue {
  const context = useContext(UndoContext);

  if (!context) {
    throw new Error("useUndo must be used inside <UndoProvider>");
  }

  return context;
}
