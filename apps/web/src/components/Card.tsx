export function Card({
  children,
  className = "",
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <section
      className={`rounded-card border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(36,49,43,0.04)] ${className}`}
    >
      {children}
    </section>
  );
}
