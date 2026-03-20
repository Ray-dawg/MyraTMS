# MyraTMS Security Audit Report
Date: 2026-03-07

## CRITICAL
SEC-001 FIXED: Hardcoded Mapbox token - components/global-load-map.tsx line 10
SEC-002 IN PROGRESS: Unauthenticated POST /api/notifications
SEC-003 IN PROGRESS: JWT role bypass - middleware.ts (decode without verify)
SEC-004 IN PROGRESS: Middleware path prefix too broad - startsWith check
SEC-005 TODO: Middleware matcher bypasses auth for dotted URLs
SEC-006 TODO: IDOR on all 15 load endpoints (no carrier ownership check)
SEC-007 TODO: CSV formula injection on import
SEC-008 TODO: Unlimited SSE connections DoS
SEC-009 TODO: Push subscription without driver ownership check

## HIGH
SEC-010 IN PROGRESS: LIKE injection in 6 files (matching, loads, ai chat)
SEC-011 TODO: Fake POD upload - no load ownership check
SEC-012 TODO: GPS spoofing - any driver can submit location for any load
SEC-013 TODO: SSE newline injection in event names
SEC-014 IN PROGRESS: Missing auth on shippers/[id] GET and PATCH
SEC-015 IN PROGRESS: app_pin returned in GET /api/drivers
SEC-016 IN PROGRESS: Driver POST missing RBAC
SEC-017 INFO: Cron auth bypass in dev mode

## MEDIUM
SEC-018 TODO: Import execute auth guard unclear
SEC-019 FIXED: Sign Out missing onClick handler - app-sidebar.tsx
SEC-020 TODO: CORS headers incomplete for cross-origin API calls
SEC-021 IN PROGRESS: Notification field mismatch (description vs body, timestamp vs created_at)
