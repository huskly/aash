import { useId, type ReactNode } from 'react';
import { cn } from '../lib/utils';

export function MetricTooltip({
  children,
  description,
  className,
}: {
  children: ReactNode;
  description: string;
  className?: string;
}) {
  const tooltipId = useId();

  return (
    <div className={cn('metric-tooltip', className)} tabIndex={0} aria-describedby={tooltipId}>
      {children}
      <span id={tooltipId} role="tooltip" className="metric-tooltip-content">
        {description}
      </span>
    </div>
  );
}
