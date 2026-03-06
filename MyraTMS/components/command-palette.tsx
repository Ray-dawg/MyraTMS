"use client"

import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  LayoutDashboard,
  Truck,
  Building2,
  Users,
  FileText,
  DollarSign,
  Brain,
  Plus,
  Upload,
  ClipboardList,
  Settings,
  BarChart3,
  UserCircle,
  Globe,
  ShieldCheck,
} from "lucide-react"

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()

  const runCommand = (command: () => void) => {
    onOpenChange(false)
    command()
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => runCommand(() => router.push("/"))}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/loadboard"))}>
            <Globe className="mr-2 h-4 w-4" />
            Load Board
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/loads"))}>
            <Truck className="mr-2 h-4 w-4" />
            Loads
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/shippers"))}>
            <Building2 className="mr-2 h-4 w-4" />
            Shippers
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/carriers"))}>
            <Users className="mr-2 h-4 w-4" />
            Carriers
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/compliance"))}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            Compliance
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/documents"))}>
            <FileText className="mr-2 h-4 w-4" />
            Documents
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/finance"))}>
            <DollarSign className="mr-2 h-4 w-4" />
            Finance
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/intelligence"))}>
            <Brain className="mr-2 h-4 w-4" />
            Intelligence
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/reports"))}>
            <BarChart3 className="mr-2 h-4 w-4" />
            Reports
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/workflows"))}>
            <ClipboardList className="mr-2 h-4 w-4" />
            Workflows
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/profile"))}>
            <UserCircle className="mr-2 h-4 w-4" />
            Profile
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/settings"))}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick Actions">
          <CommandItem onSelect={() => runCommand(() => router.push("/loads?new=true"))}>
            <Plus className="mr-2 h-4 w-4" />
            New Load
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/loadboard"))}>
            <Globe className="mr-2 h-4 w-4" />
            Search Load Boards
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/shippers?add=true"))}>
            <Plus className="mr-2 h-4 w-4" />
            Add Shipper
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/carriers?add=true"))}>
            <Plus className="mr-2 h-4 w-4" />
            Add Carrier
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/compliance"))}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            Run Compliance Check
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push("/documents"))}>
            <Upload className="mr-2 h-4 w-4" />
            Upload Document
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
