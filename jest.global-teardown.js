// Removes the Keycloak jest.global-setup.js started, if it started one.
const { remove } = require("./jest.global-setup")

module.exports = async function globalTeardown(){
    const name = process.env.IDP_ADMIN_TEST_KEYCLOAK_CONTAINER
    if(name) remove(name)
}
