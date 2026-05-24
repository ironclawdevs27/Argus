import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LOCAL_VIDEO = path.resolve(
  __dirname,
  '..',
  'Argus_bg.mp4',
)

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'serve-argus-video',
      configureServer(server) {
        server.middlewares.use('/argus-video.mp4', (req, res) => {
          try {
            const stat = fs.statSync(LOCAL_VIDEO)
            const fileSize = stat.size
            const range = req.headers.range

            res.setHeader('Content-Type', 'video/mp4')
            res.setHeader('Accept-Ranges', 'bytes')

            if (range) {
              const [startStr, endStr] = range.replace(/bytes=/, '').split('-')
              const start = parseInt(startStr, 10)
              const end = endStr ? parseInt(endStr, 10) : fileSize - 1
              const chunkSize = end - start + 1
              res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
              res.setHeader('Content-Length', chunkSize)
              res.statusCode = 206
              fs.createReadStream(LOCAL_VIDEO, { start, end }).pipe(res)
            } else {
              res.setHeader('Content-Length', fileSize)
              res.statusCode = 200
              fs.createReadStream(LOCAL_VIDEO).pipe(res)
            }
          } catch {
            res.statusCode = 404
            res.end('Video file not found')
          }
        })
      },
    },
  ],
})
