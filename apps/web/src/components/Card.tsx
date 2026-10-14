export function Card({
  children,
  className = "",
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <section
      className={`rounded-card border border-line bg-surface p-6 shadow-card ${className}`}
    >
      {children}
    </section>
  );
}
