import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.machinezoo.sourceafis.FingerprintCompatibility;
import com.machinezoo.sourceafis.FingerprintImage;
import com.machinezoo.sourceafis.FingerprintImageOptions;
import com.machinezoo.sourceafis.FingerprintMatcher;
import com.machinezoo.sourceafis.FingerprintTemplate;
import com.machinezoo.fingerprintio.TemplateFormat;
import com.machinezoo.fingerprintio.iso19794p2v2005.Iso19794p2v2005Template;
import com.machinezoo.fingerprintio.iso19794p2v2005.Iso19794p2v2005Fingerprint;
import com.machinezoo.fingerprintio.iso19794p2v2005.Iso19794p2v2005Minutia;
import com.machinezoo.fingerprintio.iso19794p2v2005.Iso19794p2v2005MinutiaType;
import com.machinezoo.fingerprintio.iso19794p2v2005.Iso19794p2v2005Position;
import com.machinezoo.fingerprintio.iso19794p2v2005.Iso19794p2v2005ScanType;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Matcher sidecar (ADR-010) — SourceAFIS 3.18 behind a tiny raw-body HTTP API.
 *
 * Run (JDK 17+ single-file source launcher; compiles in memory on start):
 *   java -cp "sidecar/lib/*" sidecar/MatcherSidecar.java [port]
 *
 * All template/image payloads cross as raw request bodies; parameters ride the
 * query string — no JSON parsing is needed inside the sidecar. Responses are
 * small hand-built JSON objects. Template bytes NEVER leave the sidecar except
 * as explicit extract results requested by the caller (ADR-011).
 */
public class MatcherSidecar {

    /** candidate store: "uid:finger" -> template */
    static final Map<String, FingerprintTemplate> templates = new ConcurrentHashMap<>();

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 28090;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/", MatcherSidecar::route);
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
        server.start();
        System.out.println("MATCHER_SIDECAR_READY port=" + port);
        System.out.flush();
    }

    static void route(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod();
        Map<String, String> p = query(ex.getRequestURI().getRawQuery());
        byte[] body = readAll(ex.getRequestBody());
        try {
            switch (method) {
                case "GET": {
                    if (path.equals("/health")) {
                        respond(ex, 200, "{\"ok\":true,\"engine\":\"sourceafis\",\"templates\":" + templates.size() + "}");
                        return;
                    }
                    if (path.equals("/synthetic")) { // no payload — a pure function of the query
                        respond(ex, dispatchPost(path, p, body));
                        return;
                    }
                    break;
                }
                case "POST": {
                    respond(ex, dispatchPost(path, p, body));
                    return;
                }
                case "DELETE": {
                    if (path.equals("/templates")) { // clear-all — used by the app's purge flow (ADR-011 §5)
                        int n = templates.size();
                        templates.clear();
                        respond(ex, 200, "{\"ok\":true,\"purged\":" + n + ",\"templates\":" + templates.size() + "}");
                        return;
                    }
                    if (path.startsWith("/templates/")) {
                        String[] parts = path.substring("/templates/".length()).split("/");
                        if (parts.length == 2) {
                            templates.remove(parts[0] + ":" + parts[1]);
                            respond(ex, 200, "{\"ok\":true,\"templates\":" + templates.size() + "}");
                            return;
                        }
                    }
                    break;
                }
                default: break;
            }
            respond(ex, 404, err("not-found"));
        } catch (Throwable e) {
            respond(ex, 422, err(sanitize(String.valueOf(e))));
        }
    }

    /** POST endpoints — each returns [status, json]. */
    static Response dispatchPost(String path, Map<String, String> p, byte[] body) {
        switch (path) {
            case "/extract": {
                int dpi = intOr(p, "dpi", 500);
                FingerprintTemplate t = extract(body, dpi);
                return new Response(200, "{\"ok\":true,\"format\":\"iso19794-2\""
                        + qualityJson(body)
                        + ",\"templateB64\":\"" + b64(FingerprintCompatibility.exportTemplates(TemplateFormat.ISO_19794_2_2005, t)) + "\""
                        + "}");
            }
            case "/synthetic": {
                // Deterministic synthetic ISO 19794-2 template (test/seed fixture — synthetic
                // minutiae, never real, per NFR-07; same spirit as the app's syntheticTemplate seeds).
                // seed → base minutiae; rot/jitter/drop perturb them like a re-presentation
                // of the same finger (rotation °, position jitter px, minutiae dropped %).
                int seed = intOr(p, "seed", 1);
                int rot = intOr(p, "rot", 0);
                int jitter = intOr(p, "jitter", 0);
                int drop = Math.max(0, Math.min(90, intOr(p, "drop", 0)));
                int n = 0;
                Iso19794p2v2005Template t = syntheticIso(seed, rot, jitter, drop);
                for (Iso19794p2v2005Fingerprint fp : t.fingerprints) n += fp.minutiae.size();
                return new Response(200, "{\"ok\":true,\"format\":\"iso19794-2\",\"minutiae\":" + n
                        + ",\"templateB64\":\"" + b64(t.toByteArray()) + "\"}");
            }
            case "/templates": {
                int uid = Integer.parseInt(p.getOrDefault("uid", "-1"));
                int finger = Integer.parseInt(p.getOrDefault("finger", "-1"));
                if (uid < 0 || finger < 0) return new Response(400, err("uid/finger required"));
                FingerprintTemplate t = load(p.getOrDefault("kind", "template"), body);
                templates.put(uid + ":" + finger, t);
                return new Response(200, "{\"ok\":true,\"templates\":" + templates.size() + "}");
            }
            case "/identify": {
                FingerprintTemplate probe = load(p.getOrDefault("kind", "template"), body);
                int top = intOr(p, "top", 5);
                List<double[]> scored = new ArrayList<>();
                for (Map.Entry<String, FingerprintTemplate> e : templates.entrySet()) {
                    double score = new FingerprintMatcher(probe).match(e.getValue());
                    String[] key = e.getKey().split(":");
                    scored.add(new double[]{score, Double.parseDouble(key[0]), Double.parseDouble(key[1])});
                }
                scored.sort(Comparator.comparingDouble((double[] a) -> -a[0]));
                StringBuilder sb = new StringBuilder("{\"ok\":true,\"candidates\":[");
                int n = Math.min(top, scored.size());
                for (int i = 0; i < n; i++) {
                    if (i > 0) sb.append(',');
                    sb.append("{\"uid\":").append((long) scored.get(i)[1])
                      .append(",\"finger\":").append((long) scored.get(i)[2])
                      .append(",\"score\":").append(fmt(scored.get(i)[0])).append('}');
                }
                sb.append("]}");
                return new Response(200, sb.toString());
            }
            case "/verify": {
                int uid = Integer.parseInt(p.getOrDefault("uid", "-1"));
                int finger = Integer.parseInt(p.getOrDefault("finger", "-1"));
                FingerprintTemplate candidate = templates.get(uid + ":" + finger);
                if (candidate == null) return new Response(404, err("no-template"));
                FingerprintTemplate probe = load(p.getOrDefault("kind", "template"), body);
                double score = new FingerprintMatcher(probe).match(candidate);
                return new Response(200, "{\"ok\":true,\"score\":" + fmt(score) + "}");
            }
            case "/match": {
                // two length-prefixed payloads [lenA u32][A][lenB u32][B] — consistency check
                if (body.length < 8) return new Response(400, err("body too short"));
                int lenA = u32(body, 0);
                if (8 + lenA + 4 > body.length) return new Response(400, err("bad framing"));
                int lenB = u32(body, 4 + lenA);
                byte[] a = java.util.Arrays.copyOfRange(body, 4, 4 + lenA);
                byte[] b = java.util.Arrays.copyOfRange(body, 8 + lenA, Math.min(body.length, 8 + lenA + lenB));
                double score = new FingerprintMatcher(load("template", a)).match(load("template", b));
                return new Response(200, "{\"ok\":true,\"score\":" + fmt(score) + "}");
            }
            default:
                return new Response(404, err("not-found"));
        }
    }

    static FingerprintTemplate extract(byte[] image, int dpi) {
        return new FingerprintTemplate(new FingerprintImage(image, new FingerprintImageOptions().dpi(dpi)));
    }

    /**
     * Capture-quality measurement over the decoded image (ADR-009 / FR-16.1).
     * Measurement only — the *policy* (thresholds, verdict) lives in the app so it
     * stays configurable (ADR-011 §7). brightness = grayscale mean (0-255);
     * sharpness = Laplacian variance (blur metric); coverage = fraction of 8×8
     * blocks with texture (ridge presence — rejects blank/partial frames).
     */
    static String qualityJson(byte[] image) {
        try {
            java.awt.image.BufferedImage img = javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(image));
            if (img == null) return "";
            int w = img.getWidth(), h = img.getHeight();
            int[] gray = new int[w * h];
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int p = img.getRGB(x, y);
                    int r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
                    gray[y * w + x] = (r * 77 + g * 151 + b * 28) >> 8;
                }
            }
            double sum = 0;
            for (int v : gray) sum += v;
            double brightness = sum / gray.length;
            double lapSum = 0, lapSq = 0;
            int n = 0;
            for (int y = 1; y < h - 1; y++) {
                for (int x = 1; x < w - 1; x++) {
                    int c = gray[y * w + x];
                    double lap = Math.abs(4.0 * c - gray[(y - 1) * w + x] - gray[(y + 1) * w + x] - gray[y * w + x - 1] - gray[y * w + x + 1]);
                    lapSum += lap;
                    lapSq += lap * lap;
                    n++;
                }
            }
            double lapMean = n > 0 ? lapSum / n : 0;
            double sharpness = n > 0 ? Math.max(0, lapSq / n - lapMean * lapMean) : 0;
            int blocks = 0, textured = 0;
            for (int by = 0; by < h; by += 8) {
                for (int bx = 0; bx < w; bx += 8) {
                    double bs = 0, bsq = 0;
                    int bn = 0;
                    for (int y = by; y < Math.min(by + 8, h); y++) {
                        for (int x = bx; x < Math.min(bx + 8, w); x++) {
                            double v = gray[y * w + x];
                            bs += v;
                            bsq += v * v;
                            bn++;
                        }
                    }
                    if (bn == 0) continue;
                    double mean = bs / bn, var = Math.max(0, bsq / bn - mean * mean);
                    blocks++;
                    if (Math.sqrt(var) > 12) textured++;
                }
            }
            double coverage = blocks > 0 ? (double) textured / blocks : 0;
            return ",\"quality\":{\"brightness\":" + fmt(brightness)
                    + ",\"sharpness\":" + fmt(sharpness)
                    + ",\"coverage\":" + fmt(coverage) + "}";
        } catch (Throwable e) {
            return ""; // metrics are best-effort; extraction result carries the verdict
        }
    }

    /**
     * Deterministic synthetic ISO 19794-2 template — synthetic minutiae only (NFR-07), never
     * real. `seed` derives the base minutiae set (a "finger"); rot/jitter/drop perturb it like
     * a re-presentation of the same finger (rotation °, per-minutia position jitter px, angle
     * noise, drop-out %). Enrolled templates use rot=0,jitter=0,drop=0.
     */
    static Iso19794p2v2005Template syntheticIso(int seed, int rotDeg, int jitter, int dropPct) {
        final int W = 300, H = 300, N = 36;
        Lcg r = new Lcg(seed * 2654435761L + 0x9E3779B9L);
        int[][] base = new int[N][5]; // x, y, angle, type, quality
        for (int i = 0; i < N; i++) {
            base[i][0] = 20 + (int) (r.next01() * (W - 40));
            base[i][1] = 20 + (int) (r.next01() * (H - 40));
            base[i][2] = (int) (r.next01() * 360);
            base[i][3] = r.next01() < 0.5 ? 0 : 1; // 0 ending, 1 bifurcation
            base[i][4] = 60 + (int) (r.next01() * 36);
        }
        double cx = 0, cy = 0;
        for (int[] m : base) { cx += m[0]; cy += m[1]; }
        cx /= N; cy /= N;
        double rad = Math.toRadians(rotDeg);
        Iso19794p2v2005Template t = new Iso19794p2v2005Template();
        t.width = W; t.height = H; t.resolutionX = 500; t.resolutionY = 500;
        t.sensorId = 0; t.sensorCertified = false;
        Iso19794p2v2005Fingerprint fp = new Iso19794p2v2005Fingerprint();
        fp.position = Iso19794p2v2005Position.RIGHT_INDEX;
        fp.scanType = Iso19794p2v2005ScanType.LIVE_PLAIN;
        fp.quality = 80;
        fp.view = 0;
        fp.minutiae = new ArrayList<>();
        for (int[] m : base) {
            if (dropPct > 0 && r.next01() * 100 < dropPct) continue;
            int dx = m[0] - (int) cx, dy = m[1] - (int) cy;
            int jx = jitter > 0 ? (int) Math.round((r.next01() * 2 - 1) * jitter) : 0;
            int jy = jitter > 0 ? (int) Math.round((r.next01() * 2 - 1) * jitter) : 0;
            int an = jitter > 0 ? (int) Math.round((r.next01() * 2 - 1) * 10) : 0;
            Iso19794p2v2005Minutia mi = new Iso19794p2v2005Minutia();
            mi.positionX = clamp(0, W - 1, (int) Math.round(dx * Math.cos(rad) - dy * Math.sin(rad)) + (int) cx + jx);
            mi.positionY = clamp(0, H - 1, (int) Math.round(dx * Math.sin(rad) + dy * Math.cos(rad)) + (int) cy + jy);
            mi.angle = (((m[2] + rotDeg + an) % 360 + 360) % 360) / 2; // ISO 19794-2: 2°-units, unsigned byte
            mi.type = m[3] == 0 ? Iso19794p2v2005MinutiaType.ENDING : Iso19794p2v2005MinutiaType.BIFURCATION;
            mi.quality = m[4];
            fp.minutiae.add(mi);
        }
        t.fingerprints = new ArrayList<>(List.of(fp));
        return t;
    }

    static int clamp(int lo, int hi, int v) { return v < lo ? lo : v > hi ? hi : v; }

    /** Tiny deterministic LCG — keeps fixtures auditable and reproducible. */
    static final class Lcg {
        private long s;
        Lcg(long seed) { this.s = seed; }
        double next01() {
            s = s * 6364136223846793005L + 1442695040888963407L;
            return ((s >>> 32) & 0xFFFFFF) / (double) 0x1000000;
        }
    }

    static FingerprintTemplate load(String kind, byte[] body) {
        if ("image".equals(kind)) return extract(body, 500);
        if (body.length == 0) throw new IllegalArgumentException("empty template body");
        return FingerprintCompatibility.importTemplate(body); // accepts ISO 19794-2 / ANSI 378 / native
    }

    static final class Response {
        final int status;
        final String json;
        Response(int status, String json) { this.status = status; this.json = json; }
    }

    static void respond(HttpExchange ex, Response r) throws IOException {
        respond(ex, r.status, r.json);
    }

    static String sanitize(String s) {
        return s.replace("\\", "\\\\").replace("\"", "'").replaceAll("[\\r\\n]", " ");
    }

    static String err(String code) { return "{\"ok\":false,\"error\":\"" + code + "\"}"; }

    static String fmt(double d) { return String.format(java.util.Locale.ROOT, "%.3f", d); }

    static String b64(byte[] b) { return java.util.Base64.getEncoder().encodeToString(b); }

    static int u32(byte[] b, int off) {
        return ((b[off] & 0xff)) | ((b[off + 1] & 0xff) << 8) | ((b[off + 2] & 0xff) << 16) | ((b[off + 3] & 0xff) << 24);
    }

    static int intOr(Map<String, String> p, String k, int dflt) {
        String v = p.get(k);
        return v == null ? dflt : Integer.parseInt(v);
    }

    static Map<String, String> query(String raw) {
        Map<String, String> out = new TreeMap<>();
        if (raw == null || raw.isEmpty()) return out;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) out.put(urlDecode(pair), "");
            else out.put(urlDecode(pair.substring(0, eq)), urlDecode(pair.substring(eq + 1)));
        }
        return out;
    }

    static String urlDecode(String s) {
        return java.net.URLDecoder.decode(s, StandardCharsets.UTF_8);
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    static void respond(HttpExchange ex, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(body);
        }
        ex.close();
    }
}
