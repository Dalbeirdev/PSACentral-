package redact

import (
	"strings"
	"testing"
)

func TestTextRedactsSecretsAndPersonalData(t *testing.T) {
	in := `POST https://apiuser:Sup3rS3cret@webservices5.autotask.net failed: password=hunter22 token: abcd1234efgh ` +
		`Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig contact jane.doe@client.example ` +
		`enrollment psacc_enr_Ab12Cd34Ef56 key 0123456789abcdef0123456789abcdef`
	out := Text(in, 1000)
	for _, leaked := range []string{"Sup3rS3cret", "hunter22", "abcd1234efgh", "eyJhbGciOiJIUzI1NiJ9", "jane.doe@client.example", "Ab12Cd34Ef56", "0123456789abcdef0123456789abcdef"} {
		if strings.Contains(out, leaked) {
			t.Errorf("%q leaked in %q", leaked, out)
		}
	}
	for _, kept := range []string{"webservices5.autotask.net", "failed", "[EMAIL]", "psacc_enr_[REDACTED]"} {
		if !strings.Contains(out, kept) {
			t.Errorf("%q missing from %q", kept, out)
		}
	}
}

func TestTextLimitsLength(t *testing.T) {
	out := Text(strings.Repeat("é", 300), 200)
	if n := len([]rune(out)); n != 200 || !strings.HasSuffix(out, "…") {
		t.Fatalf("got %d runes", n)
	}
}
