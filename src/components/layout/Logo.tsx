export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <rect width="64" height="64" rx="15" fill="var(--primary)" />
      <rect x="15" y="17" width="28" height="22" rx="4.5" fill="#ffffff" fillOpacity="0.45" />
      <rect x="21" y="25" width="28" height="22" rx="4.5" fill="#ffffff" />
      <path d="M29 36.5l4 4 8-9" fill="none" stroke="var(--primary)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
