import { cn } from "@/lib/utils"

const statusStyles: Record<string, string> = {
  // Load statuses
  "Booked": "bg-chart-1/10 text-chart-1",
  "Dispatched": "bg-chart-4/10 text-chart-4",
  "In Transit": "bg-accent/10 text-accent",
  "Delivered": "bg-success/10 text-success",
  "Invoiced": "bg-chart-2/10 text-chart-2",
  "Closed": "bg-muted text-muted-foreground",
  // Invoice statuses
  "Pending": "bg-chart-4/10 text-chart-4",
  "Sent": "bg-accent/10 text-accent",
  "Paid": "bg-success/10 text-success",
  "Overdue": "bg-destructive/10 text-destructive",
  // Insurance
  "Active": "bg-success/10 text-success",
  "Expiring": "bg-warning/10 text-warning",
  "Expired": "bg-destructive/10 text-destructive",
  // Documents
  "Complete": "bg-success/10 text-success",
  "Missing": "bg-destructive/10 text-destructive",
  "Pending Review": "bg-chart-4/10 text-chart-4",
  // Contract
  "Contracted": "bg-success/10 text-success",
  "One-off": "bg-chart-4/10 text-chart-4",
  "Prospect": "bg-muted text-muted-foreground",
  // Pipeline stages
  "Contacted": "bg-chart-1/10 text-chart-1",
  "Negotiation": "bg-chart-4/10 text-chart-4",
  "Contract Sent": "bg-accent/10 text-accent",
  "Contract Signed": "bg-success/10 text-success",
  "Dormant": "bg-muted text-muted-foreground",
  // Factoring
  "N/A": "bg-muted text-muted-foreground",
  "Submitted": "bg-chart-1/10 text-chart-1",
  "Approved": "bg-accent/10 text-accent",
  "Funded": "bg-success/10 text-success",
}

export function StatusBadge({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        statusStyles[status] || "bg-muted text-muted-foreground",
        className
      )}
    >
      {status}
    </span>
  )
}
