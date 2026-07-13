package com.fpsvic.dodgeblitz

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import kotlin.math.hypot
import kotlin.math.max
import kotlin.random.Random

/**
 * Endless dodge game rendered on a SurfaceView with a dedicated game-loop thread.
 * Drag to steer the player, avoid falling obstacles, and survive as long as possible.
 */
class GameView(context: Context) : SurfaceView(context), SurfaceHolder.Callback, Runnable {

    private var gameThread: Thread? = null
    @Volatile private var running = false

    private val prefs = context.getSharedPreferences("dodge_blitz", Context.MODE_PRIVATE)

    private val playerPaint = Paint().apply { color = Color.parseColor("#00E5A0"); isAntiAlias = true }
    private val obstaclePaint = Paint().apply { color = Color.parseColor("#FF4B4B"); isAntiAlias = true }
    private val textPaint = Paint().apply {
        color = Color.WHITE
        textSize = 56f
        isAntiAlias = true
        textAlign = Paint.Align.LEFT
    }
    private val centerTextPaint = Paint().apply {
        color = Color.WHITE
        textSize = 72f
        isAntiAlias = true
        textAlign = Paint.Align.CENTER
    }
    private val backgroundPaint = Paint().apply { color = Color.parseColor("#101018") }

    private var playerX = 0f
    private var playerY = 0f
    private val playerRadius = 34f
    private var targetX = 0f

    private data class Obstacle(var x: Float, var y: Float, val radius: Float, var speed: Float)
    private val obstacles = mutableListOf<Obstacle>()

    private var score = 0f
    private var highScore = prefs.getInt("high_score", 0)
    private var gameOver = false
    private var spawnTimer = 0f
    private var spawnInterval = 1.1f
    private var elapsed = 0f

    private var lastFrameTime = System.nanoTime()

    init {
        holder.addCallback(this)
        isFocusable = true
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        resetGame()
        resume()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        pause()
    }

    fun resume() {
        if (running) return
        running = true
        gameThread = Thread(this).also { it.start() }
    }

    fun pause() {
        running = false
        gameThread?.join(200)
        gameThread = null
    }

    private fun resetGame() {
        playerX = (width.takeIf { it > 0 } ?: 1080).toFloat() / 2f
        targetX = playerX
        playerY = (height.takeIf { it > 0 } ?: 1920) * 0.85f
        obstacles.clear()
        score = 0f
        spawnTimer = 0f
        spawnInterval = 1.1f
        elapsed = 0f
        gameOver = false
        lastFrameTime = System.nanoTime()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                if (gameOver) {
                    resetGame()
                } else {
                    targetX = event.x
                }
            }
            MotionEvent.ACTION_MOVE -> targetX = event.x
        }
        return true
    }

    override fun run() {
        while (running) {
            val now = System.nanoTime()
            var dt = (now - lastFrameTime) / 1_000_000_000f
            lastFrameTime = now
            dt = dt.coerceAtMost(0.05f)

            if (!gameOver) update(dt)

            val canvas = holder.lockCanvas() ?: continue
            try {
                draw(canvas)
            } finally {
                holder.unlockCanvasAndPost(canvas)
            }

            Thread.sleep(1000L / 60L)
        }
    }

    private fun update(dt: Float) {
        elapsed += dt
        score += dt * 10f

        playerX += (targetX - playerX) * 0.2f
        playerX = playerX.coerceIn(playerRadius, width - playerRadius)

        spawnTimer += dt
        spawnInterval = max(0.45f, 1.1f - elapsed * 0.01f)
        if (spawnTimer >= spawnInterval) {
            spawnTimer = 0f
            val radius = Random.nextInt(20, 46).toFloat()
            val x = Random.nextFloat() * (width - 2 * radius) + radius
            val speed = 260f + elapsed * 8f + Random.nextInt(0, 80)
            obstacles.add(Obstacle(x, -radius, radius, speed))
        }

        val iterator = obstacles.iterator()
        while (iterator.hasNext()) {
            val obstacle = iterator.next()
            obstacle.y += obstacle.speed * dt
            if (obstacle.y - obstacle.radius > height) {
                iterator.remove()
                continue
            }
            val distance = hypot((obstacle.x - playerX).toDouble(), (obstacle.y - playerY).toDouble())
            if (distance < obstacle.radius + playerRadius) {
                triggerGameOver()
            }
        }
    }

    private fun triggerGameOver() {
        gameOver = true
        val finalScore = score.toInt()
        if (finalScore > highScore) {
            highScore = finalScore
            prefs.edit().putInt("high_score", highScore).apply()
        }
    }

    private fun draw(canvas: Canvas) {
        canvas.drawRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), backgroundPaint)

        for (obstacle in obstacles) {
            canvas.drawCircle(obstacle.x, obstacle.y, obstacle.radius, obstaclePaint)
        }

        canvas.drawCircle(playerX, playerY, playerRadius, playerPaint)

        canvas.drawText("Score: ${score.toInt()}", 40f, 100f, textPaint)
        canvas.drawText("Best: $highScore", 40f, 160f, textPaint)

        if (gameOver) {
            canvas.drawText("GAME OVER", width / 2f, height / 2f - 40f, centerTextPaint)
            canvas.drawText("Tap to restart", width / 2f, height / 2f + 50f, centerTextPaint)
        }
    }
}
