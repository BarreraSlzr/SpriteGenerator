// Accent Token Types for InternetFriends Design System

export type AccentToken =
  | "primary"
  | "secondary"
  | "accent"
  | "muted"
  | "destructive"
  | "warning"
  | "success";

export interface AccentProps {
  accent?: AccentToken;
  accentIntensity?: "subtle" | "normal" | "strong";
  adaptiveAccent?: boolean;
}

export const ACCENT_TOKENS: Record<AccentToken, string> = {
  primary: "hsl(var(--primary))",
  secondary: "hsl(var(--secondary))",
  accent: "hsl(var(--accent))",
  muted: "hsl(var(--muted))",
  destructive: "hsl(var(--destructive))",
  warning: "hsl(var(--warning))",
  success: "hsl(var(--success))",
} as const;
