package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPasswordHashing(t *testing.T) {
	h, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "pbkdf2-sha256$600000$") {
		t.Fatalf("unexpected format %q", h)
	}
	if !VerifyPassword(h, "correct horse battery staple") || VerifyPassword(h, "correct horse battery stapl") {
		t.Fatal("verification is wrong")
	}
	h2, _ := HashPassword("correct horse battery staple")
	if h == h2 {
		t.Fatal("salts must differ")
	}
	for _, bad := range []string{"", "md5$x", "pbkdf2-sha256$10$a$b", "pbkdf2-sha256$600000$!!$b"} {
		if VerifyPassword(bad, "x") {
			t.Errorf("%q must not verify", bad)
		}
	}
}

func TestPasswordPolicy(t *testing.T) {
	if ValidatePassword("admin", "short") == nil {
		t.Error("short passwords must be rejected")
	}
	if ValidatePassword("operator", "my-operator-password") == nil {
		t.Error("passwords containing the user name must be rejected")
	}
	if err := ValidatePassword("operator", "a long enough passphrase"); err != nil {
		t.Error(err)
	}
}

func TestGuardRejectsNonLoopbackHostsAndCrossOriginPosts(t *testing.T) {
	s := &Server{}
	ok := s.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	cases := []struct {
		method, host, origin, path string
		want                       int
	}{
		{"GET", "127.0.0.1:18042", "", "/", 204},
		{"GET", "localhost:18042", "", "/", 204},
		{"GET", "evil.example:18042", "", "/", http.StatusMisdirectedRequest}, // DNS rebinding
		{"GET", "edge-api:8480", "", "/healthz", 204},                         // agent and compose probes use the service name
		{"GET", "edge-api:8480", "", "/api/status", http.StatusMisdirectedRequest},
		{"POST", "edge-api:8480", "", "/healthz", http.StatusMisdirectedRequest},
		{"POST", "127.0.0.1:18042", "http://127.0.0.1:18042", "/", 204},
		{"POST", "127.0.0.1:18042", "https://evil.example", "/", http.StatusForbidden},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "http://"+c.host+c.path, nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		ok.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%s %s%s origin=%q: got %d, want %d", c.method, c.host, c.path, c.origin, w.Code, c.want)
		}
		if w.Header().Get("Content-Security-Policy") == "" || w.Header().Get("X-Frame-Options") != "DENY" {
			t.Errorf("security headers missing")
		}
	}
}
