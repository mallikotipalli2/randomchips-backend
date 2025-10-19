// CORS configuration - FIXED (removed regex that was causing issues)
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://randomchips-frontend.vercel.app",
    "https://randomchips.vercel.app",
    "https://randomchips.in",
    "https://www.randomchips.in"
  ],
  methods: ["GET", "POST"],
  credentials: true
};