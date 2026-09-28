// The order.create versions this plugin accepts: /info advertises them and processBatch enforces them (one source).
export const SUPPORTED_ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3]
// The contract versions shared by all five register commands.
export const SUPPORTED_REGISTER_VERSIONS: readonly number[] = [1]
