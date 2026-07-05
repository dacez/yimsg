package dal

import (
	"reflect"
	"testing"
)

func TestDALMethodNamingMigration(t *testing.T) {
	checkHasNoMethod(t, reflect.TypeOf((*UserStore)(nil)), "GetInfos")
	checkHasMethod(t, reflect.TypeOf((*UserStore)(nil)), "ListByUIDs")

	checkHasNoMethod(t, reflect.TypeOf((*GroupStore)(nil)), "GetInfos")
	checkHasMethod(t, reflect.TypeOf((*GroupStore)(nil)), "ListByIDs")
	checkHasNoMethod(t, reflect.TypeOf((*GroupStore)(nil)), "GetMembers")
	checkHasMethod(t, reflect.TypeOf((*GroupStore)(nil)), "ListAllMembers")

	checkHasNoMethod(t, reflect.TypeOf((*UserSessionStore)(nil)), "GetTokens")
	checkHasMethod(t, reflect.TypeOf((*UserSessionStore)(nil)), "ListTokens")
}

func checkHasMethod(t *testing.T, ty reflect.Type, method string) {
	t.Helper()
	if _, ok := ty.MethodByName(method); !ok {
		t.Fatalf("expected method %s on %s", method, ty.String())
	}
}

func checkHasNoMethod(t *testing.T, ty reflect.Type, method string) {
	t.Helper()
	if _, ok := ty.MethodByName(method); ok {
		t.Fatalf("did not expect method %s on %s", method, ty.String())
	}
}
