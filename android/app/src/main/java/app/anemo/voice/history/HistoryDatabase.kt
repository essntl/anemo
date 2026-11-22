package app.anemo.voice.history

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import app.anemo.voice.core.HistoryEntry
import app.anemo.voice.core.HistoryStore

/**
 * The last 50 requests: what was heard, the request made of it, the spoken answer and
 * the chat link. Nothing else of a request (no audio) is kept on the phone.
 */
@Entity(tableName = "requests", indices = [Index("runId")])
data class RequestRow(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val runId: String,
    val conversationId: String,
    val heard: String,
    val request: String,
    val answer: String?,
    val chatLink: String,
    val createdAt: Long,
)

/** The DAO's SQL, as constants so JVM tests run the same statements on SQLite. */
object HistorySql {
    const val TRIM = "DELETE FROM requests WHERE id NOT IN (SELECT id FROM requests ORDER BY id DESC LIMIT :keep)"
    const val SET_ANSWER = "UPDATE requests SET answer = :answer WHERE runId = :runId"
    const val RECENT = "SELECT * FROM requests ORDER BY id DESC LIMIT :limit"
}

@Dao
abstract class RequestDao {
    @Insert
    abstract fun insert(row: RequestRow)

    @Query(HistorySql.TRIM)
    abstract fun trim(keep: Int)

    @Transaction
    open fun insertAndTrim(row: RequestRow, keep: Int) {
        insert(row)
        trim(keep)
    }

    @Query(HistorySql.SET_ANSWER)
    abstract fun setAnswer(runId: String, answer: String)

    @Query(HistorySql.RECENT)
    abstract fun recent(limit: Int): List<RequestRow>
}

@Database(entities = [RequestRow::class], version = 1, exportSchema = true)
abstract class HistoryDatabase : RoomDatabase() {
    abstract fun requests(): RequestDao

    companion object {
        @Volatile private var instance: HistoryDatabase? = null

        fun get(context: Context): HistoryDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, HistoryDatabase::class.java, "history.db")
                .build()
                .also { instance = it }
        }
    }
}

/** [HistoryStore] on Room. Called off the main thread (the service's voice thread). */
class RoomHistoryStore(private val dao: RequestDao) : HistoryStore {
    override fun add(entry: HistoryEntry) = dao.insertAndTrim(
        RequestRow(
            runId = entry.runId,
            conversationId = entry.conversationId,
            heard = entry.heard,
            request = entry.request,
            answer = entry.answer,
            chatLink = entry.chatLink,
            createdAt = entry.createdAt,
        ),
        HistoryStore.LIMIT,
    )

    override fun setAnswer(runId: String, answer: String) = dao.setAnswer(runId, answer)

    override fun recent(): List<HistoryEntry> = dao.recent(HistoryStore.LIMIT).map {
        HistoryEntry(it.runId, it.conversationId, it.heard, it.request, it.answer, it.chatLink, it.createdAt)
    }
}
