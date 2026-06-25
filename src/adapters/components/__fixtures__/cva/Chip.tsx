import { cva } from "class-variance-authority";
import { cn } from "../ui/utils";

// shadcn-style: classes live in cva variants, not on className.
const chipVariants = cva("rounded-md", {
  variants: {
    tone: { primary: "bg-primary text-primary-foreground", muted: "bg-card-foreground" },
    size: { sm: "text-sm", md: "" },
  },
  defaultVariants: { tone: "primary", size: "md" },
});

export function Chip({
  className,
  tone,
  size,
}: {
  className?: string;
  tone?: "primary" | "muted";
  size?: "sm" | "md";
}) {
  return <span data-slot="chip" className={cn(chipVariants({ tone, size }), className)} />;
}
