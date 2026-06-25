import { cn } from "./utils";

// A shadcn-style component using className via cn() — the common pattern.
export function Badge({ className, ...props }: { className?: string }) {
  return (
    <span
      data-slot="badge"
      className={cn("bg-primary text-primary-foreground rounded-md px-2", className)}
      {...props}
    />
  );
}

// Multiple components per file (like card.tsx) — this one renders Badge (composed-of).
export function BadgeGroup({ className }: { className?: string }) {
  return (
    <div className={cn("flex gap-2 text-card-foreground", className)}>
      <Badge variant="primary" />
      <Badge variant="secondary" />
    </div>
  );
}

// Not a component: lowercase, no JSX.
function helper() {
  return 42;
}
