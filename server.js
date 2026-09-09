const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const TIKWM_API = "https://www.tikwm.com/api/?url=";
const FASTSAVER_API_KEY = process.env.FASTSAVER_API_KEY || "";

// Serve files from the project root.
app.use(express.static(path.join(__dirname, "public")));

function hostOf(value) {
    try {
        return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}

function isTikTokUrl(value) {
    const host = hostOf(value);
    const allowed = ["tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"];
    return allowed.some(h => host === h || host.endsWith("." + h));
}

function isFacebookUrl(value) {
    const host = hostOf(value);
    const allowed = ["facebook.com", "m.facebook.com", "fb.com", "fb.watch"];
    return allowed.some(h => host === h || host.endsWith("." + h));
}

// Proxy the user's ImgBB page and return the actual image referenced by og:image.
// This keeps the exact logo link the user supplied without requiring a direct image URL.
app.get("/api/logo", async (req, res) => {
    try {
        const imageUrl = "https://i.ibb.co/939rV6QG/file-00000000298081fa8fb79014c0077f3b.png";
        const image = await fetch(imageUrl, {headers: {"User-Agent":"Mozilla/5.0"}});
        if (!image.ok || !image.body) throw new Error("Logo fetch failed");
        res.setHeader("Content-Type", image.headers.get("content-type") || "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.end(Buffer.from(await image.arrayBuffer()));
    } catch (error) {
        res.status(200).setHeader("Content-Type","image/png");
        res.setHeader("Cache-Control","public, max-age=300");
        res.end(Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64"
        ));
    }
});

async function fetchTikTok(url) {
    const response = await fetch(TIKWM_API + encodeURIComponent(url), {
        headers: {
            "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
            "Accept":"application/json"
        }
    });
    if (!response.ok) throw new Error(`TikWM API returned ${response.status}`);
    const json = await response.json();
    const data = json?.data;
    if (!data?.play) throw new Error("No downloadable video was found");
    return {
        ok:true,
        title:data.title || "Media Save Video",
        author:data.author?.nickname || data.author?.unique_id || "",
        cover:data.cover || "",
        duration:data.duration || 0,
        video:`/api/media?url=${encodeURIComponent(data.play)}&type=video`,
        audio:data.music ? `/api/media?url=${encodeURIComponent(data.music)}&type=audio` : null
    };
}

async function fetchFacebookWithFastSaver(url) {
    if (!FASTSAVER_API_KEY) throw new Error("Facebook API key not configured");
    const response = await fetch("https://fastsaverapi.com/facebook-video-downloader-api/fetch?url=" + encodeURIComponent(url), {
        headers: {"X-Api-Key":FASTSAVER_API_KEY, "Accept":"application/json"}
    });
    if (!response.ok) throw new Error(`Facebook API returned ${response.status}`);
    const json = await response.json();
    const videoUrl = json?.video_url || json?.url || json?.download_url || json?.data?.video_url || json?.data?.url;
    if (!videoUrl) throw new Error("Facebook API returned no video URL");
    return {
        ok:true,
        title:json?.title || json?.data?.title || "Media Save Video",
        author:json?.uploader || json?.data?.uploader || "",
        cover:json?.thumbnail || json?.data?.thumbnail || "",
        duration:json?.duration || json?.data?.duration || 0,
        video:`/api/media?url=${encodeURIComponent(videoUrl)}&type=video`,
        audio:null
    };
}

// Public Facebook fallback: extracts common og:video/meta video URLs.
// Private/login-only posts cannot be downloaded this way.
async function fetchFacebookPublic(url) {
    const response = await fetch(url, {
        redirect:"follow",
        headers:{
            "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
            "Accept":"text/html,application/xhtml+xml"
        }
    });
    if (!response.ok) throw new Error(`Facebook page returned ${response.status}`);
    const html = await response.text();

    const candidates = [];
    const patterns = [
      /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url)?["']/gi,
      /"playable_url(?:_quality_hd)?":"([^"]+)"/gi,
      /"browser_native_hd_url":"([^"]+)"/gi,
      /"browser_native_sd_url":"([^"]+)"/gi
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html))) candidates.push(m[1].replace(/\\u0025/g,"%").replace(/\\\//g,"/").replace(/\\u0026/g,"&"));
    }
    const videoUrl = candidates.find(x => /^https?:\/\//i.test(x));
    if (!videoUrl) throw new Error("No public Facebook video URL found");
    return {
        ok:true,title:"Media Save Video",author:"",cover:"",
        duration:0,video:`/api/media?url=${encodeURIComponent(videoUrl)}&type=video`,audio:null
    };
}

app.get("/api/download", async (req,res)=>{
    const url=String(req.query.url || "").trim();
    if(!url) return res.status(400).json({ok:false,error:"TikTok URL is required."});
    if(!isTikTokUrl(url) && !isFacebookUrl(url))
        return res.status(400).json({ok:false,error:"Invalid media URL."});

    try {
        const data = isTikTokUrl(url)
            ? await fetchTikTok(url)
            : (FASTSAVER_API_KEY ? await fetchFacebookWithFastSaver(url) : await fetchFacebookPublic(url));
        res.json(data);
    } catch(error) {
        console.error("Download API Error:", error.message);
        res.status(502).json({ok:false,error:"Media service is temporarily unavailable, the post may be private, or the link is not supported."});
    }
});

app.get("/api/media", async (req,res)=>{
    const target=String(req.query.url || "").trim();
    const type=req.query.type==="audio" ? "audio" : "video";
    if(!target) return res.status(400).send("Missing media URL.");
    try {
        const mediaUrl=new URL(target);
        if(mediaUrl.protocol!=="https:") return res.status(400).send("Invalid media URL.");

        const upstream=await fetch(mediaUrl,{
          headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"}
        });
        if(!upstream.ok || !upstream.body) return res.status(502).send("Media could not be fetched.");

        res.setHeader("Content-Type",upstream.headers.get("content-type") || (type==="audio"?"audio/mpeg":"video/mp4"));
        res.setHeader("Cache-Control","public, max-age=300");
        res.setHeader("Content-Disposition",`attachment; filename="media-save-${type==="audio"?"audio.mp3":"video.mp4"}"`);

        const contentLength=upstream.headers.get("content-length");
        if(contentLength) res.setHeader("Content-Length",contentLength);

        const reader=upstream.body.getReader();
        res.on("close",()=>reader.cancel().catch(()=>{}));
        while(true){
            const {done,value}=await reader.read();
            if(done) break;
            res.write(Buffer.from(value));
        }
        res.end();
    } catch(error) {
        console.error("Media Proxy Error:",error.message);
        if(!res.headersSent) res.status(502).send("Media proxy failed.");
        else res.end();
    }
});

// SPA fallback
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>{
    console.log("╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮");
    console.log("      🚀 MEDIA SAVE");
    console.log("╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯");
    console.log(`🌐 Server running on port ${PORT}`);
    console.log("🎬 TikTok Downloader: READY");
    console.log("📘 Facebook Reels: READY");
    console.log("📲 PWA Install: READY");
    console.log("🎧 Audio Support: READY");
});
