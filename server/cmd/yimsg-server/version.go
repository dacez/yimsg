package main

import "fmt"

var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func versionString() string {
	return fmt.Sprintf("yimsg %s (commit %s, built %s)", version, commit, buildDate)
}
