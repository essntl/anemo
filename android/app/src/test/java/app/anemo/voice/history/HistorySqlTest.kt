package app.anemo.voice.history

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.sql.DriverManager

/** The DAO's statements on SQLite, with the table Room makes for [RequestRow]. */
class HistorySqlTest {
    private val db = DriverManager.getConnection("jdbc:sqlite::memory:")

    init {
        db.createStatement().execute(
            "CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, runId TEXT NOT NULL, " +
                "conversationId TEXT NOT NULL, heard TEXT NOT NULL, request TEXT NOT NULL, answer TEXT, " +
                "chatLink TEXT NOT NULL, createdAt INTEGER NOT NULL)",
        )
    }

    @After
    fun tearDown() = db.close()

    /** Room's `:name` parameters become JDBC's `?`, in order. */
    private fun run(sql: String, vararg args: Any) {
        db.prepareStatement(sql.replace(Regex(":[A-Za-z]+"), "?")).use { st ->
            args.forEachIndexed { i, a -> st.setObject(i + 1, a) }
            st.execute()
        }
    }

    private fun recent(limit: Int): List<Pair<String, String?>> =
        db.prepareStatement(HistorySql.RECENT.replace(":limit", "?")).use { st ->
            st.setInt(1, limit)
            st.executeQuery().use { rs ->
                buildList { while (rs.next()) add(rs.getString("runId") to rs.getString("answer")) }
            }
        }

    private fun insert(n: Int) = run(
        "INSERT INTO requests (runId, conversationId, heard, request, answer, chatLink, createdAt) VALUES (?,?,?,?,?,?,?)",
        "r$n", "c$n", "heard", "request", "", "https://x/c/c$n", n.toLong(),
    )

    @Test
    fun `keeps the newest fifty`() {
        for (n in 1..60) {
            insert(n)
            run(HistorySql.TRIM, 50)
        }
        val rows = recent(100)
        assertEquals(50, rows.size)
        assertEquals("r60", rows.first().first)
        assertEquals("r11", rows.last().first)
    }

    @Test
    fun `the answer is set on its run`() {
        insert(1)
        insert(2)
        run(HistorySql.SET_ANSWER, "Done.", "r1")
        assertEquals(listOf("r2" to "", "r1" to "Done."), recent(50))
    }
}
