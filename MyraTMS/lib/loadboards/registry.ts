/**
 * Client registry — maps source → LoadBoardAPIClient instance.
 *
 * Why singletons: clients are cheap to construct, but OAuth token caches
 * (e.g. lib/loadboards/dat/oauth.ts) live inside the client. Sharing
 * instances across cron invocations means token reuse across polls.
 *
 * Adding a new source = (1) implement the client, (2) add a line here,
 * (3) add the source to the loadboard_sources table.
 */

import type { LoadBoardAPIClient, LoadBoardSource } from './base';
import { DATAPIClient } from './dat/client';
import { TruckstopAPIClient } from './truckstop/client';
import { LoadBoard123APIClient } from './loadboard123/client';
import { LoadlinkAPIClient } from './loadlink/client';

const clients: Record<LoadBoardSource, LoadBoardAPIClient> = {
  dat: new DATAPIClient(),
  truckstop: new TruckstopAPIClient(),
  '123lb': new LoadBoard123APIClient(),
  loadlink: new LoadlinkAPIClient(),
};

export function getClient(source: LoadBoardSource): LoadBoardAPIClient {
  const c = clients[source];
  if (!c) throw new Error(`No LoadBoardAPIClient registered for source=${source}`);
  return c;
}

export function allSources(): LoadBoardSource[] {
  return Object.keys(clients) as LoadBoardSource[];
}
