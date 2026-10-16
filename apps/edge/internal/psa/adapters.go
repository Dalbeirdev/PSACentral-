package psa

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
)

func base64Encode(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func needCredentials(c *Conn, keys ...string) (Result, bool) {
	if m := c.missing(keys...); len(m) > 0 {
		return Result{Code: CodeNotConfigured, Detail: "Credentials are missing: " + strings.Join(m, ", ") + ". Enter them in this appliance's local admin UI."}, false
	}
	return Result{}, true
}

func trimSlash(s string) string { return strings.TrimRight(s, "/") }

// Autotask REST (ported from the reference connector): three header credentials and a query for
// one company — the smallest call that proves the API user can read data.
func testAutotask(ctx context.Context, c *Conn) Result {
	if r, ok := needCredentials(c, "username", "secret", "integrationCode"); !ok {
		return r
	}
	r, _ := do(ctx, c, probe{
		method:  http.MethodPost,
		url:     trimSlash(c.Endpoint) + "/V1.0/Companies/query",
		headers: map[string]string{"ApiIntegrationCode": c.cred("integrationCode"), "UserName": c.cred("username"), "Secret": c.cred("secret")},
		body:    []byte(`{"MaxRecords":1,"filter":[{"op":"gte","field":"id","value":0}]}`),
	}, true)
	r.Identity = map[string]string{"api": "Autotask REST v1.0"}
	return r
}

// ConnectWise PSA (Manage) REST 3.0 (ported from the reference connector): Basic
// "companyId+publicKey:privateKey" plus the integration clientId header; one company.
func testConnectWise(ctx context.Context, c *Conn) Result {
	if r, ok := needCredentials(c, "publicKey", "privateKey", "clientId"); !ok {
		return r
	}
	company := c.str("companyId")
	if company == "" {
		return Result{Code: CodeInvalidConfig, Detail: "The ConnectWise company ID is missing from the instance configuration."}
	}
	r, _ := do(ctx, c, probe{
		method:  http.MethodGet,
		url:     trimSlash(c.Endpoint) + "/company/companies?pageSize=1",
		headers: map[string]string{"Authorization": basicAuth(company+"+"+c.cred("publicKey"), c.cred("privateKey")), "clientId": c.cred("clientId")},
	}, true)
	r.Identity = map[string]string{"api": "ConnectWise Manage REST 3.0", "company": company}
	return r
}

// HaloPSA: OAuth 2.0 client credentials at <tenantUrl>/auth/token (hosted tenants add ?tenant=),
// then one client record through the API. Written from the vendor documentation.
func testHalo(ctx context.Context, c *Conn) Result {
	if r, ok := needCredentials(c, "clientId", "clientSecret"); !ok {
		return r
	}
	tenantURL := trimSlash(c.str("tenantUrl"))
	if tenantURL == "" {
		tenantURL = strings.TrimSuffix(trimSlash(c.Endpoint), "/api")
	}
	tokenURL := tenantURL + "/auth/token"
	if t := c.str("tenant"); t != "" {
		tokenURL += "?tenant=" + url.QueryEscape(t)
	}
	scope := c.str("scope")
	if scope == "" {
		scope = "all"
	}
	token, r := tokenRequest(ctx, c, tokenURL, url.Values{"grant_type": {"client_credentials"}, "client_id": {c.cred("clientId")}, "client_secret": {c.cred("clientSecret")}, "scope": {scope}}, nil)
	if token == "" {
		return r
	}
	r, _ = do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/Client?pageinate=true&page_size=1&page_no=1", headers: map[string]string{"Authorization": "Bearer " + token}}, true)
	r.Identity = map[string]string{"api": "HaloPSA REST"}
	return r
}

// Kaseya BMS: password grant at <region>/api/token with the tenant name, then one account.
// Written from the vendor documentation.
func testKaseya(ctx context.Context, c *Conn) Result {
	if r, ok := needCredentials(c, "username", "password"); !ok {
		return r
	}
	tenant := c.str("tenant")
	if tenant == "" {
		return Result{Code: CodeInvalidConfig, Detail: "The Kaseya BMS tenant name is missing from the instance configuration."}
	}
	token, r := tokenRequest(ctx, c, trimSlash(c.Endpoint)+"/token", url.Values{"grant_type": {"password"}, "username": {c.cred("username")}, "password": {c.cred("password")}, "tenant": {tenant}}, nil)
	if token == "" {
		return r
	}
	r, _ = do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/crm/accounts?page=1&pageSize=1", headers: map[string]string{"Authorization": "Bearer " + token}}, true)
	r.Identity = map[string]string{"api": "Kaseya BMS REST", "tenant": tenant}
	return r
}

// Freshservice API v2: Basic "apiKey:X"; one ticket page.
func testFreshservice(ctx context.Context, c *Conn) Result {
	if r, ok := needCredentials(c, "apiKey"); !ok {
		return r
	}
	r, _ := do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/tickets?per_page=1", headers: map[string]string{"Authorization": basicAuth(c.cred("apiKey"), "X")}}, true)
	r.Identity = map[string]string{"api": "Freshservice API v2"}
	return r
}

// ServiceNow Table API: Basic, or OAuth 2.0 password grant at <instance>/oauth_token.do; one row of
// the configured ticket table.
func testServiceNow(ctx context.Context, c *Conn) Result {
	table := c.str("incidentTable")
	if table == "" {
		table = "incident"
	}
	auth := ""
	switch c.AuthMethod {
	case "basic":
		if r, ok := needCredentials(c, "username", "password"); !ok {
			return r
		}
		auth = basicAuth(c.cred("username"), c.cred("password"))
	case "oauth2_password":
		if r, ok := needCredentials(c, "clientId", "clientSecret", "username", "password"); !ok {
			return r
		}
		instance := trimSlash(c.str("instanceUrl"))
		if instance == "" {
			instance = strings.TrimSuffix(trimSlash(c.Endpoint), "/api/now")
		}
		token, r := tokenRequest(ctx, c, instance+"/oauth_token.do", url.Values{
			"grant_type": {"password"}, "client_id": {c.cred("clientId")}, "client_secret": {c.cred("clientSecret")}, "username": {c.cred("username")}, "password": {c.cred("password")},
		}, nil)
		if token == "" {
			return r
		}
		auth = "Bearer " + token
	default:
		return Result{Code: CodeUnsupported, Detail: "Unknown ServiceNow authentication method."}
	}
	r, _ := do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/table/" + url.PathEscape(table) + "?sysparm_limit=1", headers: map[string]string{"Authorization": auth}}, true)
	r.Identity = map[string]string{"api": "ServiceNow Table API", "table": table}
	return r
}

// Custom REST: API key header, Basic, or OAuth 2.0 client credentials (tokenUrl); GET the health
// path when configured, otherwise the tickets path.
func testCustomREST(ctx context.Context, c *Conn) Result {
	headers := map[string]string{}
	switch c.AuthMethod {
	case "api_key":
		if r, ok := needCredentials(c, "apiKey"); !ok {
			return r
		}
		h := c.str("apiKeyHeader")
		if h == "" {
			h = "X-API-Key"
		}
		headers[h] = c.cred("apiKey")
	case "basic":
		if r, ok := needCredentials(c, "username", "password"); !ok {
			return r
		}
		headers["Authorization"] = basicAuth(c.cred("username"), c.cred("password"))
	case "oauth2_client_credentials":
		if r, ok := needCredentials(c, "clientId", "clientSecret"); !ok {
			return r
		}
		tokenURL := c.str("tokenUrl")
		if tokenURL == "" {
			return Result{Code: CodeInvalidConfig, Detail: "OAuth 2.0 needs the token URL in the instance configuration."}
		}
		token, r := tokenRequest(ctx, c, tokenURL, url.Values{"grant_type": {"client_credentials"}, "client_id": {c.cred("clientId")}, "client_secret": {c.cred("clientSecret")}}, nil)
		if token == "" {
			return r
		}
		headers["Authorization"] = "Bearer " + token
	default:
		return Result{Code: CodeUnsupported, Detail: "Unknown authentication method for the custom REST adapter."}
	}
	path := c.str("healthPath")
	if path == "" {
		path = c.str("ticketsPath")
	}
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		return Result{Code: CodeInvalidConfig, Detail: "The health or tickets path must start with /."}
	}
	r, _ := do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + path, headers: headers}, false)
	r.Identity = map[string]string{"api": "Custom REST", "path": path}
	return r
}
