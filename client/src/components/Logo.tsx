export default function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 104 122" className={className} fill="currentColor" aria-hidden="true">
      <rect x="0" y="0" width="104" height="18" />
      <rect x="8" y="24" width="88" height="18" />
      <rect x="16" y="48" width="72" height="18" />
      <polygon points="24,72 80,72 52,122" fill="#C9A227" />
    </svg>
  );
}
