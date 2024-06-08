const keys = Object.keys(process.env)

const npm_package_keys = []
const npm_config_keys = []

for(const key of keys) {
    if (key.startsWith('npm_package')) {
        npm_package_keys.push(key.split('npm_package')[1].slice(1))
    } else if (key.startsWith('npm_config')) {
        npm_config_keys.push(key.split('npm_config')[1].slice(1))
    }
}

// console.log(JSON.stringify(npm_package_keys))
// console.log(JSON.stringify(npm_config_keys))

console.log(process.env.npm_config_registry)
console.log(process.env.npm_package_config_xxxx)
console.log(process.env.npm_lifecycle_event)

