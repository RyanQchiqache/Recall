export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <rect width="64" height="64" rx="16" fill="var(--primary)" />
      <rect x="14" y="20" width="30" height="22" rx="5" fill="#c7d2fe" />
      <rect x="20" y="24" width="30" height="22" rx="5" fill="#fff" />
      <path d="M28 35l4 4 8-9" fill="none" stroke="#4f46e5" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
