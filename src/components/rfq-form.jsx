"use client"

import { Package, MapPin, Clock, Shield } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function RFQForm({ rfq, onChange, disabled }) {
  const update = (key, value) => {
    onChange({ ...rfq, [key]: value })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="item" className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider">
          <Package className="h-3 w-3" />
          Item / Part
        </Label>
        <Input
          id="item"
          placeholder="e.g. Stainless steel hex bolts M8x30"
          value={rfq.item}
          onChange={(e) => update("item", e.target.value)}
          disabled={disabled}
          className="bg-muted/50 border-border/50 text-foreground placeholder:text-muted-foreground/50 h-9"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="quantity" className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider">
            Quantity
          </Label>
          <Input
            id="quantity"
            placeholder="e.g. 25,000"
            value={rfq.quantity}
            onChange={(e) => update("quantity", e.target.value)}
            disabled={disabled}
            className="bg-muted/50 border-border/50 text-foreground placeholder:text-muted-foreground/50 h-9"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="location" className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider">
            <MapPin className="h-3 w-3" />
            Location
          </Label>
          <Input
            id="location"
            placeholder="e.g. Shenzhen, China"
            value={rfq.location}
            onChange={(e) => update("location", e.target.value)}
            disabled={disabled}
            className="bg-muted/50 border-border/50 text-foreground placeholder:text-muted-foreground/50 h-9"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="leadTime" className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider">
            <Clock className="h-3 w-3" />
            Max Lead Time
          </Label>
          <Input
            id="leadTime"
            placeholder="e.g. 30 days"
            value={rfq.leadTime}
            onChange={(e) => update("leadTime", e.target.value)}
            disabled={disabled}
            className="bg-muted/50 border-border/50 text-foreground placeholder:text-muted-foreground/50 h-9"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="quality" className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider">
            <Shield className="h-3 w-3" />
            Quality Req.
          </Label>
          <Input
            id="quality"
            placeholder="e.g. ISO 9001"
            value={rfq.quality}
            onChange={(e) => update("quality", e.target.value)}
            disabled={disabled}
            className="bg-muted/50 border-border/50 text-foreground placeholder:text-muted-foreground/50 h-9"
          />
        </div>
      </div>
    </div>
  )
}
