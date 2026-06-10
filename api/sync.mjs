import sql from '../lib/db.mjs';
import { authenticateRequest } from '../lib/auth.mjs';

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const user = await authenticateRequest(req);
    if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { lastSync, routes, logs } = req.body || {};
    const userId = user.userId;

    // The Garmin watch app marks itself with client=watch (in the body;
    // query params break Connect IQ's makeWebRequest). Connect IQ has a
    // strict web-response size limit, so for the watch we return slim routes
    // (no depthProfiles/weather/etc.) and omit logs entirely.
    const isWatch = req.query?.client === 'watch' ||
        (req.body && req.body.client === 'watch');

    try {
        // --- Process client route pushes ---
        if (routes?.upserted?.length) {
            for (const r of routes.upserted) {
                await sql`
                    INSERT INTO routes (user_id, local_id, name, route_timestamp, waypoints, params, depth_profiles, weather, bounds, updated_at)
                    VALUES (
                        ${userId}, ${r.localId}, ${r.name}, ${r.timestamp},
                        ${JSON.stringify(r.waypoints)}, ${JSON.stringify(r.params || null)},
                        ${JSON.stringify(r.depthProfiles || null)}, ${JSON.stringify(r.weather || null)},
                        ${JSON.stringify(r.bounds || null)}, ${r.updatedAt}
                    )
                    ON CONFLICT (user_id, local_id) DO UPDATE SET
                        name = EXCLUDED.name,
                        route_timestamp = EXCLUDED.route_timestamp,
                        waypoints = EXCLUDED.waypoints,
                        params = EXCLUDED.params,
                        depth_profiles = EXCLUDED.depth_profiles,
                        weather = EXCLUDED.weather,
                        bounds = EXCLUDED.bounds,
                        updated_at = EXCLUDED.updated_at,
                        deleted = false
                    WHERE routes.updated_at < EXCLUDED.updated_at
                `;
            }
        }

        // --- Process client route deletes ---
        if (routes?.deleted?.length) {
            for (const localId of routes.deleted) {
                await sql`
                    UPDATE routes SET deleted = true, updated_at = now()
                    WHERE user_id = ${userId} AND local_id = ${localId} AND deleted = false
                `;
            }
        }

        // --- Process client log pushes ---
        if (logs?.upserted?.length) {
            for (const l of logs.upserted) {
                await sql`
                    INSERT INTO logs (user_id, local_id, captain_name, departure_location, departure_datetime,
                        destination_location, arrival_datetime, closed, entries, updated_at)
                    VALUES (
                        ${userId}, ${l.localId}, ${l.captainName || null},
                        ${l.departureLocation || null}, ${l.departureDateTime || null},
                        ${l.destinationLocation || null}, ${l.arrivalDateTime || null},
                        ${l.closed || false}, ${JSON.stringify(l.entries || [])}, ${l.updatedAt}
                    )
                    ON CONFLICT (user_id, local_id) DO UPDATE SET
                        captain_name = EXCLUDED.captain_name,
                        departure_location = EXCLUDED.departure_location,
                        departure_datetime = EXCLUDED.departure_datetime,
                        destination_location = EXCLUDED.destination_location,
                        arrival_datetime = EXCLUDED.arrival_datetime,
                        closed = EXCLUDED.closed,
                        entries = EXCLUDED.entries,
                        updated_at = EXCLUDED.updated_at,
                        deleted = false
                    WHERE logs.updated_at < EXCLUDED.updated_at
                `;
            }
        }

        // --- Process client log deletes ---
        if (logs?.deleted?.length) {
            for (const localId of logs.deleted) {
                await sql`
                    UPDATE logs SET deleted = true, updated_at = now()
                    WHERE user_id = ${userId} AND local_id = ${localId} AND deleted = false
                `;
            }
        }

        // --- Pull server changes since lastSync ---
        const sinceTs = lastSync || '1970-01-01T00:00:00Z';

        const serverRoutes = await sql`
            SELECT local_id, name, route_timestamp, waypoints, params, depth_profiles, weather, bounds, updated_at, deleted
            FROM routes WHERE user_id = ${userId} AND updated_at > ${sinceTs}
        `;

        const serverLogs = await sql`
            SELECT local_id, captain_name, departure_location, departure_datetime,
                   destination_location, arrival_datetime, closed, entries, updated_at, deleted
            FROM logs WHERE user_id = ${userId} AND updated_at > ${sinceTs}
        `;

        // Split into upserted/deleted
        const routeUpserted = serverRoutes
            .filter(r => !r.deleted)
            .map(r => isWatch
                ? {
                    // Slim payload for the watch — only what it navigates with.
                    localId: r.local_id,
                    name: r.name,
                    timestamp: Number(r.route_timestamp),
                    waypoints: r.waypoints
                }
                : {
                    localId: r.local_id,
                    name: r.name,
                    timestamp: Number(r.route_timestamp),
                    waypoints: r.waypoints,
                    params: r.params,
                    depthProfiles: r.depth_profiles,
                    weather: r.weather,
                    bounds: r.bounds,
                    updatedAt: r.updated_at
                });
        const routeDeleted = serverRoutes.filter(r => r.deleted).map(r => r.local_id);

        const logUpserted = serverLogs
            .filter(l => !l.deleted)
            .map(l => ({
                localId: l.local_id,
                captainName: l.captain_name,
                departureLocation: l.departure_location,
                departureDateTime: l.departure_datetime,
                destinationLocation: l.destination_location,
                arrivalDateTime: l.arrival_datetime,
                closed: l.closed,
                entries: l.entries,
                updatedAt: l.updated_at
            }));
        const logDeleted = serverLogs.filter(l => l.deleted).map(l => l.local_id);

        // Get server time for next sync cursor
        const timeResult = await sql`SELECT now() AS server_time`;
        const serverTime = timeResult[0].server_time;

        return res.status(200).json({
            serverTime,
            routes: { upserted: routeUpserted, deleted: routeDeleted },
            logs: isWatch
                ? { upserted: [], deleted: [] }
                : { upserted: logUpserted, deleted: logDeleted }
        });
    } catch (err) {
        console.error('Sync error:', err);
        return res.status(500).json({ error: 'Sync failed' });
    }
}
