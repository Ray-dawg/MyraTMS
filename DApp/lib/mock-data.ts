export type LoadStatus = 'assigned' | 'en_route_pickup' | 'at_pickup' | 'loaded' | 'en_route_delivery' | 'at_delivery' | 'delivered' | 'completed'

export interface LoadStop {
  type: 'pickup' | 'delivery'
  name: string
  address: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
  scheduledTime: string
  actualTime?: string
  contactName: string
  contactPhone: string
  notes?: string
}

export interface Load {
  id: string
  referenceNumber: string
  status: LoadStatus
  pickup: LoadStop
  delivery: LoadStop
  commodity: string
  weight: number
  miles: number
  rate: number
  broker: string
  brokerPhone: string
  equipment: string
  specialInstructions?: string
  createdAt: string
  updatedAt: string
}

export const statusLabels: Record<LoadStatus, string> = {
  assigned: 'Assigned',
  en_route_pickup: 'En Route to Pickup',
  at_pickup: 'At Pickup',
  loaded: 'Loaded',
  en_route_delivery: 'En Route to Delivery',
  at_delivery: 'At Delivery',
  delivered: 'Delivered',
  completed: 'Completed',
}

export const statusColors: Record<LoadStatus, string> = {
  assigned: 'bg-info text-info-foreground',
  en_route_pickup: 'bg-warning text-warning-foreground',
  at_pickup: 'bg-accent text-accent-foreground',
  loaded: 'bg-success text-success-foreground',
  en_route_delivery: 'bg-warning text-warning-foreground',
  at_delivery: 'bg-accent text-accent-foreground',
  delivered: 'bg-success text-success-foreground',
  completed: 'bg-muted text-muted-foreground',
}

export const mockLoads: Load[] = [
  {
    id: 'LD-2847',
    referenceNumber: 'REF-90281',
    status: 'en_route_pickup',
    pickup: {
      type: 'pickup',
      name: 'Amazon Distribution Center',
      address: '4300 Bull Creek Rd',
      city: 'Austin',
      state: 'TX',
      zip: '78731',
      lat: 30.3542,
      lng: -97.7519,
      scheduledTime: '2026-02-28T14:00:00Z',
      contactName: 'Mike Rodriguez',
      contactPhone: '(512) 555-0142',
      notes: 'Dock 7B - Check in at guard gate',
    },
    delivery: {
      type: 'delivery',
      name: 'Walmart Supercenter DC',
      address: '2401 S Pleasant Valley Rd',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
      lat: 32.7767,
      lng: -96.7970,
      scheduledTime: '2026-03-01T08:00:00Z',
      contactName: 'Sarah Chen',
      contactPhone: '(214) 555-0198',
      notes: 'Appointment required - DO NOT arrive early',
    },
    commodity: 'Consumer Electronics',
    weight: 38500,
    miles: 195,
    rate: 875,
    broker: 'CH Robinson',
    brokerPhone: '(800) 555-0123',
    equipment: 'Dry Van 53ft',
    specialInstructions: 'Temperature sensitive - keep trailer sealed. No double stacking.',
    createdAt: '2026-02-27T10:00:00Z',
    updatedAt: '2026-02-28T09:30:00Z',
  },
  {
    id: 'LD-2846',
    referenceNumber: 'REF-90280',
    status: 'assigned',
    pickup: {
      type: 'pickup',
      name: 'Georgia Pacific Mill',
      address: '1550 N Main St',
      city: 'Houston',
      state: 'TX',
      zip: '77002',
      lat: 29.7604,
      lng: -95.3698,
      scheduledTime: '2026-03-02T06:00:00Z',
      contactName: 'Jim Parker',
      contactPhone: '(713) 555-0167',
    },
    delivery: {
      type: 'delivery',
      name: 'Office Depot Warehouse',
      address: '800 S Douglas Rd',
      city: 'San Antonio',
      state: 'TX',
      zip: '78205',
      lat: 29.4241,
      lng: -98.4936,
      scheduledTime: '2026-03-02T16:00:00Z',
      contactName: 'Ana Morales',
      contactPhone: '(210) 555-0189',
    },
    commodity: 'Paper Products',
    weight: 42000,
    miles: 197,
    rate: 780,
    broker: 'TQL',
    brokerPhone: '(800) 555-0456',
    equipment: 'Dry Van 53ft',
    createdAt: '2026-02-28T08:00:00Z',
    updatedAt: '2026-02-28T08:00:00Z',
  },
  {
    id: 'LD-2843',
    referenceNumber: 'REF-90275',
    status: 'delivered',
    pickup: {
      type: 'pickup',
      name: 'Tyson Foods Plant',
      address: '400 S 4th St',
      city: 'Springdale',
      state: 'AR',
      zip: '72764',
      lat: 36.1867,
      lng: -94.1288,
      scheduledTime: '2026-02-25T05:00:00Z',
      actualTime: '2026-02-25T05:15:00Z',
      contactName: 'Robert Lee',
      contactPhone: '(479) 555-0134',
    },
    delivery: {
      type: 'delivery',
      name: 'HEB Distribution',
      address: '5000 S General Bruce Dr',
      city: 'Temple',
      state: 'TX',
      zip: '76504',
      lat: 31.0982,
      lng: -97.3428,
      scheduledTime: '2026-02-26T12:00:00Z',
      actualTime: '2026-02-26T11:45:00Z',
      contactName: 'Danny Ortiz',
      contactPhone: '(254) 555-0176',
    },
    commodity: 'Refrigerated Poultry',
    weight: 40000,
    miles: 458,
    rate: 1850,
    broker: 'Coyote Logistics',
    brokerPhone: '(800) 555-0789',
    equipment: 'Reefer 53ft',
    createdAt: '2026-02-24T14:00:00Z',
    updatedAt: '2026-02-26T12:00:00Z',
  },
  {
    id: 'LD-2840',
    referenceNumber: 'REF-90270',
    status: 'completed',
    pickup: {
      type: 'pickup',
      name: 'Lowe\'s RDC',
      address: '100 Logistics Way',
      city: 'Mount Vernon',
      state: 'TX',
      zip: '75457',
      lat: 33.1887,
      lng: -95.2213,
      scheduledTime: '2026-02-22T07:00:00Z',
      actualTime: '2026-02-22T06:55:00Z',
      contactName: 'Karen White',
      contactPhone: '(903) 555-0112',
    },
    delivery: {
      type: 'delivery',
      name: 'Lowe\'s Store #1428',
      address: '6500 W Interstate 40',
      city: 'Amarillo',
      state: 'TX',
      zip: '79106',
      lat: 35.1994,
      lng: -101.8450,
      scheduledTime: '2026-02-23T14:00:00Z',
      actualTime: '2026-02-23T13:30:00Z',
      contactName: 'Tom Briggs',
      contactPhone: '(806) 555-0145',
    },
    commodity: 'Building Materials',
    weight: 44000,
    miles: 412,
    rate: 1620,
    broker: 'XPO Logistics',
    brokerPhone: '(800) 555-0321',
    equipment: 'Flatbed 53ft',
    createdAt: '2026-02-21T10:00:00Z',
    updatedAt: '2026-02-23T15:00:00Z',
  },
  {
    id: 'LD-2835',
    referenceNumber: 'REF-90265',
    status: 'completed',
    pickup: {
      type: 'pickup',
      name: 'Caterpillar Factory',
      address: '3701 State Route 29',
      city: 'Peoria',
      state: 'IL',
      zip: '61615',
      lat: 40.7440,
      lng: -89.6065,
      scheduledTime: '2026-02-18T06:00:00Z',
      actualTime: '2026-02-18T06:10:00Z',
      contactName: 'Steve Koenig',
      contactPhone: '(309) 555-0199',
    },
    delivery: {
      type: 'delivery',
      name: 'Equipment Depot',
      address: '12000 Westheimer Rd',
      city: 'Houston',
      state: 'TX',
      zip: '77077',
      lat: 29.7363,
      lng: -95.5967,
      scheduledTime: '2026-02-20T10:00:00Z',
      actualTime: '2026-02-20T09:15:00Z',
      contactName: 'Paul Vasquez',
      contactPhone: '(281) 555-0177',
    },
    commodity: 'Heavy Equipment Parts',
    weight: 35000,
    miles: 1042,
    rate: 3200,
    broker: 'Landstar',
    brokerPhone: '(800) 555-0654',
    equipment: 'Flatbed 48ft',
    specialInstructions: 'Requires tarping. Oversize load permit on file.',
    createdAt: '2026-02-17T09:00:00Z',
    updatedAt: '2026-02-20T11:00:00Z',
  },
]

export function getActiveLoad(): Load | undefined {
  return mockLoads.find(
    (l) => !['delivered', 'completed'].includes(l.status)
  )
}

export function getUpcomingLoads(): Load[] {
  return mockLoads.filter((l) => l.status === 'assigned')
}

export function getPastLoads(): Load[] {
  return mockLoads.filter((l) =>
    ['delivered', 'completed'].includes(l.status)
  )
}

export function getLoadById(id: string): Load | undefined {
  return mockLoads.find((l) => l.id === id)
}

/** Map a TMS API load row (snake_case) to DApp Load interface */
export function mapApiLoad(row: Record<string, unknown>): Load {
  return {
    id: String(row.id || ''),
    referenceNumber: String(row.reference_number || row.referenceNumber || ''),
    status: mapApiStatus(String(row.status || 'assigned')),
    pickup: {
      type: 'pickup',
      name: String(row.shipper_name || row.origin || ''),
      address: String(row.origin || ''),
      city: extractCity(String(row.origin || '')),
      state: extractState(String(row.origin || '')),
      zip: '',
      lat: Number(row.origin_lat) || 0,
      lng: Number(row.origin_lng) || 0,
      scheduledTime: String(row.pickup_date || ''),
      contactName: '',
      contactPhone: '',
    },
    delivery: {
      type: 'delivery',
      name: String(row.destination || ''),
      address: String(row.destination || ''),
      city: extractCity(String(row.destination || '')),
      state: extractState(String(row.destination || '')),
      zip: '',
      lat: Number(row.dest_lat) || 0,
      lng: Number(row.dest_lng) || 0,
      scheduledTime: String(row.delivery_date || ''),
      contactName: '',
      contactPhone: '',
    },
    commodity: String(row.commodity || ''),
    weight: Number(row.weight) || 0,
    miles: 0,
    rate: Number(row.carrier_cost) || 0,
    broker: String(row.assigned_rep || 'Myra TMS'),
    brokerPhone: '',
    equipment: String(row.equipment || ''),
    specialInstructions: String(row.po_number ? `PO: ${row.po_number}` : ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function mapApiStatus(s: string): LoadStatus {
  const map: Record<string, LoadStatus> = {
    'Booked': 'assigned',
    'Dispatched': 'en_route_pickup',
    'In Transit': 'en_route_delivery',
    'Delivered': 'delivered',
    'Invoiced': 'completed',
    'Closed': 'completed',
  }
  return map[s] || (s as LoadStatus) || 'assigned'
}

function extractCity(location: string): string {
  const parts = location.split(',')
  return parts[0]?.trim() || location
}

function extractState(location: string): string {
  const parts = location.split(',')
  return parts[1]?.trim().substring(0, 2) || ''
}
