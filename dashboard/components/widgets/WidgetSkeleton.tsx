export interface WidgetSkeletonProps {
  type: "chart" | "kpi" | "table" | "number";
}

export function WidgetSkeleton({ type }: WidgetSkeletonProps) {
  if (type === "chart") {
    return (
      <div data-testid="widget-skeleton" role="status" aria-label="Loading" className="animate-pulse">
        <div className="h-[200px] bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
      </div>
    );
  }

  if (type === "kpi") {
    return (
      <div data-testid="widget-skeleton" role="status" aria-label="Loading" className="animate-pulse flex gap-4">
        <div className="h-[80px] flex-1 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
        <div className="h-[80px] flex-1 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
        <div className="h-[80px] flex-1 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
      </div>
    );
  }

  if (type === "table") {
    return (
      <div data-testid="widget-skeleton" role="status" aria-label="Loading" className="animate-pulse space-y-2">
        <div className="h-4 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
        <div className="h-4 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
        <div className="h-4 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
        <div className="h-4 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
        <div className="h-4 bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
      </div>
    );
  }

  return (
    <div data-testid="widget-skeleton" role="status" aria-label="Loading" className="animate-pulse">
      <div className="h-10 w-full bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle rounded" />
    </div>
  );
}
