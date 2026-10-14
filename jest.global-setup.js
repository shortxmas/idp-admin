// Starts a throwaway Keycloak before any test file runs, and points the tests at it through
// KEYCLOAK_TEST_URL; jest.global-teardown.js removes it. Set KEYCLOAK_TEST_URL yourself (in the
// environment or .env) to use a Keycloak you already run instead.
const { execFileSync } = require("node:child_process")
const { randomBytes } = require("node:crypto")
const { constants } = require("node:os")

const IMAGE = "quay.io/keycloak/keycloak:26.0"
const READY_TIMEOUT_MS = 120_000

function docker(args){
    // stderr is passed through, so a first run shows the image download
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim()
}

function remove(name){
    try{
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" })
    }catch{
        // already gone
    }
}

async function waitUntilReady(url){
    const deadline = Date.now() + READY_TIMEOUT_MS
    while(Date.now() < deadline){
        try{
            if((await fetch(`${url}/realms/master`)).ok) return
        }catch{
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`Keycloak didn't become ready within ${READY_TIMEOUT_MS / 1000}s`)
}

module.exports = async function globalSetup(){
    if(process.env.KEYCLOAK_TEST_URL) return

    try{
        docker(["version", "--format", "{{.Server.Version}}"])
    }catch{
        throw new Error("The Keycloak tests start a Keycloak container, so Docker must be installed and running. " +
            "To use a Keycloak you already run instead, set KEYCLOAK_TEST_URL (see CONTRIBUTING.md).")
    }

    const name = `idp-admin-test-keycloak-${process.pid}-${Date.now()}`
    const password = randomBytes(16).toString("hex")
    docker([
        "run", "-d", "--rm", "--name", name,
        // a free port on this machine only
        "-p", "127.0.0.1::8080",
        "-e", "KC_BOOTSTRAP_ADMIN_USERNAME=admin",
        "-e", `KC_BOOTSTRAP_ADMIN_PASSWORD=${password}`,
        IMAGE, "start-dev",
    ])
    process.env.IDP_ADMIN_TEST_KEYCLOAK_CONTAINER = name
    // if Jest exits without running the teardown: an exit, or a signal such as Ctrl-C, which would
    // otherwise end the process without an exit event
    process.once("exit", () => remove(name))
    for(const signal of ["SIGINT", "SIGTERM", "SIGHUP"]){
        process.once(signal, () => {
            remove(name)
            process.exit(128 + constants.signals[signal])
        })
    }

    try{
        const port = docker(["port", name, "8080/tcp"]).split("\n")[0].split(":").pop()
        const url = `http://127.0.0.1:${port}`
        await waitUntilReady(url)
        process.env.KEYCLOAK_TEST_URL = url
        process.env.KEYCLOAK_TEST_ADMIN_USER = "admin"
        process.env.KEYCLOAK_TEST_ADMIN_PASSWORD = password
    }catch(error){
        try{
            process.stderr.write(execFileSync("docker", ["logs", "--tail", "50", name], { encoding: "utf8" }))
        }catch{
            // no logs to show
        }
        remove(name)
        throw error
    }
}

module.exports.remove = remove
