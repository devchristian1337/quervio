// Server Card from Hirael <https://hirael.com/blocks/cloud/server-card>
// MIT · Mohammad Shehadeh · https://github.com/MohammadShehadeh/hirael
//
// In the app's colours: green and amber belong to the Environments
// (src/lib/environment.ts), and many themes' second colour is their first,
// so a healthy server takes the brand's colour and one under pressure the
// theme's destructive red, as a critical meter does; a meter nearing its
// limit is drawn in the full ink. Labels are sentence case, figures tabular.

import * as React from "react";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";

import { cn } from "@/lib/utils";

export type ServerStatus = "online" | "degraded" | "offline" | "provisioning";

const statusDot: Record<ServerStatus, string> = {
  online: "bg-primary",
  degraded: "bg-destructive",
  offline: "bg-muted-foreground",
  provisioning: "bg-primary",
};
const statusText: Record<ServerStatus, string> = {
  online: "text-primary",
  degraded: "text-destructive",
  offline: "text-muted-foreground",
  provisioning: "text-primary",
};

type ServerCardProps = React.ComponentProps<"div">;

const ServerCard = ({ className, ...props }: ServerCardProps) => {
  return (
    <div
      data-slot="server-card"
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-card p-4 text-card-foreground",
        className,
      )}
      {...props}
    />
  );
};

type ServerCardHeaderProps = React.ComponentProps<"div">;

const ServerCardHeader = ({ className, ...props }: ServerCardHeaderProps) => {
  return (
    <div
      data-slot="server-card-header"
      className={cn("flex items-start justify-between gap-3", className)}
      {...props}
    />
  );
};

interface ServerCardTitleProps extends React.ComponentProps<"div"> {
  region?: React.ReactNode;
}

const ServerCardTitle = ({
  region,
  className,
  children,
  ...props
}: ServerCardTitleProps) => {
  return (
    <div
      data-slot="server-card-title"
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    >
      <span className="truncate text-sm font-medium text-foreground">
        {children}
      </span>
      {region ? (
        <span className="truncate text-xs text-muted-foreground">{region}</span>
      ) : null}
    </div>
  );
};

interface ServerCardStatusProps extends Omit<
  React.ComponentProps<"span">,
  "children"
> {
  status: ServerStatus;
  children?: React.ReactNode;
}

const ServerCardStatus = ({
  status,
  className,
  children,
  ...props
}: ServerCardStatusProps) => {
  const live = status === "provisioning";

  return (
    <span
      data-slot="server-card-status"
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-accent px-2 py-0.5 text-[11px] font-medium",
        statusText[status],
        className,
      )}
      {...props}
    >
      <span className="relative flex size-1.5">
        {live ? (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none",
              statusDot[status],
            )}
            aria-hidden
          />
        ) : null}
        <span
          className={cn(
            "relative inline-flex size-1.5 rounded-full",
            statusDot[status],
          )}
          aria-hidden
        />
      </span>
      {children ?? status}
    </span>
  );
};

type ServerCardSpecsProps = React.ComponentProps<"dl">;

const ServerCardSpecs = ({ className, ...props }: ServerCardSpecsProps) => {
  return (
    <dl
      data-slot="server-card-specs"
      className={cn("grid grid-cols-3 gap-3", className)}
      {...props}
    />
  );
};

const specIcon = {
  cpu: Cpu,
  memory: MemoryStick,
  disk: HardDrive,
} as const;

interface ServerCardSpecProps extends React.ComponentProps<"div"> {
  label: React.ReactNode;
  icon?: keyof typeof specIcon;
}

const ServerCardSpec = ({
  label,
  icon,
  className,
  children,
  ...props
}: ServerCardSpecProps) => {
  const Icon = icon ? specIcon[icon] : null;

  return (
    <div
      data-slot="server-card-spec"
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    >
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {label}
      </dt>
      <dd className="truncate text-sm text-foreground tabular-nums">{children}</dd>
    </div>
  );
};

interface ServerCardMeterProps extends React.ComponentProps<"div"> {
  label: React.ReactNode;
  /** Percent, 0 to 100; null when the server does not report it. */
  value: number | null;
  /** Shown before the percentage, such as "4.1 of 12 GB". */
  detail?: React.ReactNode;
  /** Fraction (0 to 1) where the bar switches to warning, then destructive. */
  thresholds?: [warn: number, crit: number];
}

const ServerCardMeter = ({
  label,
  value,
  detail,
  thresholds = [0.75, 0.9],
  className,
  ...props
}: ServerCardMeterProps) => {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, Math.round(value)));
  const frac = pct / 100;
  const [warn, crit] = thresholds;
  const tone =
    frac >= crit
      ? "bg-destructive"
      : frac >= warn
        ? "bg-foreground"
        : "bg-foreground/50";

  return (
    <div
      data-slot="server-card-meter"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="truncate text-foreground tabular-nums">
          {detail ? <span className="text-muted-foreground">{detail} · </span> : null}
          {value === null ? "—" : `${pct}%`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={typeof label === "string" ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : pct}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[inline-size,background-color] duration-300 motion-reduce:transition-none",
            tone,
          )}
          style={{ inlineSize: `${pct}%` }}
        />
      </div>
    </div>
  );
};

export {
  ServerCard,
  ServerCardHeader,
  ServerCardTitle,
  ServerCardStatus,
  ServerCardSpecs,
  ServerCardSpec,
  ServerCardMeter,
};
