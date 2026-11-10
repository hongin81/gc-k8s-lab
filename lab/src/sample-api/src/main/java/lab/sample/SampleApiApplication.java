package lab.sample;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 배포 연습용 샘플 API.
 * - GET {context-path}/health : 준비 확인용 (DB 안 봄)
 * - GET {context-path}/hello  : DB 까지 연결됐는지 확인
 * 시작할 때 APP_WORK_DIR(기본 /tmp/work)에 파일을 하나 쓴다 — 읽기 전용 폴더면 기동 실패(연습 고장 3).
 */
@SpringBootApplication
@RestController
public class SampleApiApplication {

    private final JdbcTemplate jdbc;

    public SampleApiApplication(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public static void main(String[] args) throws IOException {
        Path work = Path.of(System.getenv().getOrDefault("APP_WORK_DIR", "/tmp/work"));
        Files.createDirectories(work);
        Files.writeString(work.resolve("started.txt"), Instant.now().toString());
        SpringApplication.run(SampleApiApplication.class, args);
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @GetMapping("/hello")
    public Map<String, Object> hello() {
        Map<String, Object> db = jdbc.queryForMap(
                "select now()::text as db_time, current_user as db_user, current_database() as db_name");
        return Map.of(
                "message", "샘플 API 정상 — 화면, 입구, API, DB 까지 연결됨",
                "pod", System.getenv().getOrDefault("HOSTNAME", "-"),
                "db", db);
    }
}
