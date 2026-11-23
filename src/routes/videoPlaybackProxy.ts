import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { encodeRFC5987ValueChars } from "../lib/helpers/encodeRFC5987ValueChars.ts";
import { decryptQuery } from "../lib/helpers/encryptQuery.ts";
import { StreamingApi } from "hono/utils/stream";

let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);

const videoPlaybackProxy = new Hono();

videoPlaybackProxy.options("/", () => {
    const headersForResponse: Record<string, string> = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Content-Type, Range",
    };
    return new Response("OK", {
        status: 200,
        headers: headersForResponse,
    });
});

videoPlaybackProxy.get("/", async (c) => {
    const { host, c: client, expire, title } = c.req.query();
    const urlReq = new URL(c.req.url);
    const config = c.get("config");
    const queryParams = new URLSearchParams(urlReq.search);

    if (c.req.query("enc") === "true") {
        const { data: encryptedQuery } = c.req.query();
        const decryptedQueryParams = decryptQuery(encryptedQuery, config);
        const parsedDecryptedQueryParams = new URLSearchParams(
            JSON.parse(decryptedQueryParams),
        );
        queryParams.delete("enc");
        queryParams.delete("data");
        queryParams.set("pot", parsedDecryptedQueryParams.get("pot") as string);
        queryParams.set("ip", parsedDecryptedQueryParams.get("ip") as string);
    }

    if (host == undefined || !/[\w-]+.googlevideo.com/.test(host)) {
        throw new HTTPException(400, {
            res: new Response("Host query string do not match or undefined."),
        });
    }

    if (
        expire == undefined ||
        Number(expire) < Number(Date.now().toString().slice(0, -3))
    ) {
        throw new HTTPException(400, {
            res: new Response(
                "Expire query string undefined or videoplayback URL has expired.",
            ),
        });
    }

    if (client == undefined) {
        throw new HTTPException(400, {
            res: new Response("'c' query string undefined."),
        });
    }

    queryParams.delete("host");
    queryParams.delete("title");

    const rangeHeader = c.req.header("range");
    const requestBytes = rangeHeader ? rangeHeader.split("=")[1] : null;
    const [firstByte, lastByte] = requestBytes?.split("-") || [];
    if (requestBytes) {
        queryParams.append(
            "range",
            requestBytes,
        );
    }

    const headersToSend: HeadersInit = {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "en-us,en;q=0.5",
        "origin": "https://www.youtube.com",
        "referer": "https://www.youtube.com",
    };

    if (client == "ANDROID") {
        headersToSend["user-agent"] =
            "com.google.android.youtube/1537338816 (Linux; U; Android 13; en_US; ; Build/TQ2A.230505.002; Cronet/113.0.5672.24)";
    } else if (client == "IOS") {
        headersToSend["user-agent"] =
            "com.google.ios.youtube/19.32.8 (iPhone14,5; U; CPU iOS 17_6 like Mac OS X;)";
    } else {
        headersToSend["user-agent"] =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    }

    const fetchClient = await getFetchClient(config);

    // Everything needed to answer a ranged request is already available from the
    // request itself: the client's Range header, plus `clen` and `mime` in the URL.
    // A HEAD request used to supply it, but that forced the response status to be
    // committed *before* the body had been fetched - so an upstream failure turned
    // into a well-formed 2xx with a truncated body, which players cannot tell apart
    // from end of stream and simply stall on.
    //
    // Fetch the first chunk first, and only answer once it is in hand.
    const chunkSize =
        config.networking.videoplayback.video_fetch_chunk_size_mb *
        1_000_000;

    const totalBytes = Number(queryParams.get("clen") || "0");
    const requestStartByte = Number(firstByte || "0");

    let requestEndByte: number | undefined;
    if (lastByte) {
        requestEndByte = Number(lastByte);
    } else if (totalBytes > 0) {
        requestEndByte = totalBytes - 1;
    }

    const baseUrl = new URL(
        `https://${host}/videoplayback?${queryParams.toString()}`,
    );

    // https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-p2-semantics-17#section-7.3
    // A maximum of 5 redirections is defined in the note of the section 7.3
    // of this RFC, that's why `i < 5`
    const fetchRange = async (
        start: number,
        end: number,
    ): Promise<Response> => {
        let url = new URL(baseUrl);

        for (let i = 0; i < 5; i++) {
            url.searchParams.set("range", `${start}-${end}`);
            const res = await fetchClient(url, {
                method: "POST",
                body: new Uint8Array([0x78, 0]), // protobuf: { 15: 0 } (no idea what it means but this is what YouTube uses),
                headers: headersToSend,
                redirect: "manual",
            });

            if (res.headers.has("Location")) {
                url = new URL(res.headers.get("Location") as string, url);
                try {
                    await res.body?.cancel();
                } catch (_) {
                    // nothing useful to do here
                }
                continue;
            }

            return res;
        }

        throw new Error("googlevideo redirected too many times");
    };

    // A failed chunk is usually transient (stale edge, throttling), and retrying
    // is only safe while nothing has been written to the client.
    const fetchRangeWithRetry = async (
        start: number,
        end: number,
        attempts = 3,
    ): Promise<Response> => {
        let lastStatus = 0;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const res = await fetchRange(start, end);
            // 206 is a perfectly good answer: an edge that honours the range with a
            // Content-Range header replies 206, and after a redirect the chunk fetch
            // can end up there too. Upstream used to demand exactly 200 here, which
            // turned every redirect-followed chunk into "Non-200 response from
            // google servers" -> stream.abort() -> a silent empty 206 (see #403).
            if (res.status === 200 || res.status === 206) {
                return res;
            }

            lastStatus = res.status;
            try {
                await res.body?.cancel();
            } catch (_) {
                // nothing useful to do here
            }

            if (attempt < attempts) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 200 * attempt)
                );
            }
        }

        throw new Error(
            `unusable status from googlevideo after ${attempts} attempts (last ${
                lastStatus || "n/a"
            }), range ${start}-${end}`,
        );
    };

    const firstEndByte = requestEndByte !== undefined
        ? Math.min(requestStartByte + chunkSize - 1, requestEndByte)
        : requestStartByte + chunkSize - 1;

    let firstResponse: Response;
    try {
        firstResponse = await fetchRangeWithRetry(
            requestStartByte,
            firstEndByte,
        );
    } catch (err) {
        // Nothing has been sent yet, so return a real error status: the player can
        // then retry the segment or fall back to a different rendition.
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
            `[videoplayback] ${host} range ${requestStartByte}-${firstEndByte} failed: ${detail}`,
        );
        return new Response("Upstream fetch failed", { status: 502 });
    }

    // Bind once: TypeScript cannot narrow `.body` across the closure below.
    const firstBody = firstResponse.body;
    if (!firstBody) {
        // Same reasoning as above: nothing sent yet, so fail cleanly.
        console.error(`[videoplayback] ${host} returned no body`);
        return new Response("Upstream returned no body", { status: 502 });
    }

    const headersForResponse: Record<string, string> = {
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        "content-type": firstResponse.headers.get("content-type") ||
            queryParams.get("mime") || "application/octet-stream",
    };

    if (requestEndByte !== undefined) {
        headersForResponse["content-length"] = String(
            requestEndByte - requestStartByte + 1,
        );
        headersForResponse["content-range"] =
            `bytes ${requestStartByte}-${requestEndByte}/${totalBytes || "*"}`;
    }

    if (title) {
        headersForResponse["content-disposition"] = `attachment; filename="${
            encodeURIComponent(title)
        }"; filename*=UTF-8''${encodeRFC5987ValueChars(title)}`;
    }

    // Response headers are committed below, with the first chunk already fetched.
    // Remaining chunks are streamed in order; if one fails mid-flight the stream is
    // aborted, which is visible to the client as a truncated response instead of
    // silence.
    const { readable, writable } = new TransformStream();
    const stream = new StreamingApi(writable, readable);

    const pump = async () => {
        await stream.pipe(firstBody);

        if (requestEndByte === undefined) {
            return;
        }

        for (
            let startByte = requestStartByte + chunkSize;
            startByte <= requestEndByte;
            startByte += chunkSize
        ) {
            const endByte = Math.min(startByte + chunkSize - 1, requestEndByte);
            const res = await fetchRangeWithRetry(startByte, endByte);
            if (!res.body) {
                throw new Error(`empty body for range ${startByte}-${endByte}`);
            }
            await stream.pipe(res.body);
        }
    };

    pump().then(() => stream.close()).catch((err) => {
        const detail = err instanceof Error
            ? `${err.name}: ${err.message}`
            : String(err);
        console.error(
            `[videoplayback] ${host} stream aborted after ${requestStartByte}-${
                requestEndByte ?? "?"
            }: ${detail}`,
        );
        stream.abort();
    });

    return new Response(stream.responseReadable, {
        status: requestBytes ? 206 : 200,
        headers: headersForResponse,
    });
});

export default videoPlaybackProxy;
