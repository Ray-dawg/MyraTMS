// Map lat/lng coordinates to named Ontario regions for rate cache lookup

interface City {
  name: string
  lat: number
  lng: number
  radius: number // km
}

const ONTARIO_CITIES: City[] = [
  { name: "Toronto",        lat: 43.6532, lng: -79.3832, radius: 50 },
  { name: "Ottawa",         lat: 45.4215, lng: -75.6972, radius: 40 },
  { name: "Hamilton",       lat: 43.2557, lng: -79.8711, radius: 30 },
  { name: "London",         lat: 42.9849, lng: -81.2453, radius: 35 },
  { name: "Kitchener",      lat: 43.4516, lng: -80.4925, radius: 30 },
  { name: "Windsor",        lat: 42.3149, lng: -83.0364, radius: 30 },
  { name: "Sudbury",        lat: 46.4917, lng: -80.9930, radius: 40 },
  { name: "Thunder Bay",    lat: 48.3809, lng: -89.2477, radius: 50 },
  { name: "Barrie",         lat: 44.3894, lng: -79.6903, radius: 30 },
  { name: "Kingston",       lat: 44.2312, lng: -76.4860, radius: 30 },
  { name: "Peterborough",   lat: 44.3091, lng: -78.3197, radius: 25 },
  { name: "Oshawa",         lat: 43.8971, lng: -78.8658, radius: 25 },
  { name: "Sault Ste Marie",lat: 46.5219, lng: -84.3461, radius: 40 },
  { name: "Brampton",       lat: 43.7315, lng: -79.7624, radius: 20 },
  { name: "Mississauga",    lat: 43.5890, lng: -79.6441, radius: 25 },
  { name: "Markham",        lat: 43.8561, lng: -79.3370, radius: 20 },
  { name: "Vaughan",        lat: 43.8361, lng: -79.4986, radius: 20 },
  { name: "Niagara Falls",  lat: 43.1010, lng: -79.0687, radius: 25 },
  { name: "Guelph",         lat: 43.5448, lng: -80.2482, radius: 20 },
  { name: "Cambridge",      lat: 43.3616, lng: -80.3144, radius: 20 },
]

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function normalizeRegion(lat: number, lng: number): string {
  // Check if in Ontario (rough bounding box)
  const inOntario = lat >= 41.5 && lat <= 57.0 && lng >= -95.2 && lng <= -74.3
  const province = inOntario ? "ON" : lat > 45 && lng > -67 ? "QC" : "US"

  for (const city of ONTARIO_CITIES) {
    const dist = haversineKm(lat, lng, city.lat, city.lng)
    if (dist <= city.radius) {
      return city.name
    }
  }

  // Rural classification by latitude bands
  if (province === "ON") {
    if (lat > 50) return "ON-Rural-Far-North"
    if (lat > 47) return "ON-Rural-North"
    if (lat > 45) return "ON-Rural-Central"
    return "ON-Rural-South"
  }

  return province === "QC" ? "Quebec" : "US"
}
